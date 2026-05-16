import { randomUUID } from 'node:crypto';
import type {
  ChatItem,
  ChatRole,
  ClaudeSession,
  HookDecision,
  Pending,
  SessionStatus,
} from './types.ts';

// tsx 等のローダで、`import './claude/store.ts'` と `import './store.ts'` のように
// 同じファイルを違う相対パスで参照すると別 module instance として解決されることがある
// (Node ESM の loader 実装依存)。
// その結果、ファイルスコープの Map がモジュールごとに別物になり、片方で upsert したものが
// もう片方の listSessions で見えない、というバグになる。
// 実機で persist.ts (saveSnapshot) と claude/router.ts (/api/claude/sessions) で
// 完全に別 instance になっていることを debug log で確認済み。
// シングルトン化のために globalThis 経由で共有する。
const SESSIONS_KEY = Symbol.for('headlenss.claudeStore.sessions');
const PENDING_KEY = Symbol.for('headlenss.claudeStore.pendingResolvers');
const INIT_KEY = Symbol.for('headlenss.claudeStore.initId');
type GlobalRegistry = {
  [SESSIONS_KEY]?: Map<string, ClaudeSession>;
  [PENDING_KEY]?: Map<string, (decision: HookDecision) => void>;
  [INIT_KEY]?: string;
};
const g = globalThis as unknown as GlobalRegistry;
const sessions: Map<string, ClaudeSession> = (g[SESSIONS_KEY] ??= new Map());
const pendingResolvers: Map<string, (decision: HookDecision) => void> =
  (g[PENDING_KEY] ??= new Map());
// DEBUG: 各 module instance が同じ globalThis を見ているか確認するため、初回 init を記録。
const myInitId = randomUUID().slice(0, 8);
if (!g[INIT_KEY]) g[INIT_KEY] = myInitId;
console.log(`[store:debug] module init this=${myInitId} globalInit=${g[INIT_KEY]} sessions.size=${sessions.size} globalThisKeys=${Object.getOwnPropertySymbols(globalThis).length}`);

export function __debugInfo(): { myInitId: string; globalInit: string | undefined; sessionsSize: number; sessionsKeys: string[] } {
  return {
    myInitId,
    globalInit: g[INIT_KEY],
    sessionsSize: sessions.size,
    sessionsKeys: [...sessions.keys()],
  };
}

export function listSessions(): ClaudeSession[] {
  return Array.from(sessions.values()).sort((a, b) => b.lastSeenAt - a.lastSeenAt);
}

export function getSession(tmuxName: string): ClaudeSession | undefined {
  return sessions.get(tmuxName);
}

export function upsertSession(input: {
  ccSessionId: string;
  tmuxPane: string;
  tmuxSessionName: string;
  cwd: string;
}): ClaudeSession {
  const existing = sessions.get(input.tmuxSessionName);
  const now = Date.now();
  if (existing) {
    existing.ccSessionId = input.ccSessionId;
    existing.tmuxPane = input.tmuxPane;
    existing.cwd = input.cwd;
    existing.lastSeenAt = now;
    return existing;
  }
  const fresh: ClaudeSession = {
    ccSessionId: input.ccSessionId,
    tmuxPane: input.tmuxPane,
    tmuxSessionName: input.tmuxSessionName,
    cwd: input.cwd,
    status: 'idle',
    startedAt: now,
    lastSeenAt: now,
    chat: [],
  };
  sessions.set(input.tmuxSessionName, fresh);
  return fresh;
}

export function removeSession(tmuxName: string): void {
  const s = sessions.get(tmuxName);
  if (s?.pending) {
    // Wake any long-poll waiter so it doesn't hang forever
    const resolver = pendingResolvers.get(s.pending.id);
    if (resolver) {
      resolver({ event: 'PreToolUse', permissionDecision: 'deny', reason: 'session-ended' });
      pendingResolvers.delete(s.pending.id);
    }
  }
  sessions.delete(tmuxName);
}

export function appendChat(tmuxName: string, role: ChatRole, text: string): void {
  const s = sessions.get(tmuxName);
  if (!s) return;
  if (!text.trim()) return;
  s.chat.push({ role, text, ts: Date.now() });
  s.lastSeenAt = Date.now();
  // Cap chat history to last 200 items to keep memory bounded
  if (s.chat.length > 200) s.chat.splice(0, s.chat.length - 200);
}

export function getChat(tmuxName: string): ChatItem[] {
  return sessions.get(tmuxName)?.chat ?? [];
}

export function setStatus(tmuxName: string, status: SessionStatus): void {
  const s = sessions.get(tmuxName);
  if (!s) return;
  s.status = status;
  s.lastSeenAt = Date.now();
}

/** Stop hook 用: 「ターンが終わった」マーカーを立てる */
export function markStopped(tmuxName: string): void {
  const s = sessions.get(tmuxName);
  if (!s) return;
  s.lastStopAt = Date.now();
  s.lastSeenAt = Date.now();
}

/** user-prompt-submit hook 用: 新しいターンが始まるので Stop マーカーをクリア */
export function clearStopped(tmuxName: string): void {
  const s = sessions.get(tmuxName);
  if (!s) return;
  s.lastStopAt = undefined;
  s.lastSeenAt = Date.now();
}

export function createPending(
  tmuxName: string,
  partial: Omit<Pending, 'id' | 'createdAt'>,
): Pending {
  const s = sessions.get(tmuxName);
  if (!s) throw new Error(`session not found: ${tmuxName}`);
  const pending: Pending = {
    ...partial,
    id: randomUUID(),
    createdAt: Date.now(),
  };
  s.pending = pending;
  s.status = partial.kind === 'question' ? 'waiting-question' : 'waiting-permission';
  s.lastSeenAt = Date.now();
  return pending;
}

export function getPending(tmuxName: string): Pending | undefined {
  return sessions.get(tmuxName)?.pending;
}

export function clearPending(tmuxName: string): void {
  const s = sessions.get(tmuxName);
  if (!s) return;
  s.pending = undefined;
  s.status = 'idle';
  s.lastSeenAt = Date.now();
}

/**
 * Register a long-poll resolver that will be called when G2 responds (or session ends).
 * Returns a Promise that resolves to the hook decision.
 */
export function awaitPendingResolution(
  pendingId: string,
  timeoutMs: number,
): Promise<HookDecision> {
  return new Promise<HookDecision>((resolve) => {
    let settled = false;
    const onResolve = (decision: HookDecision) => {
      if (settled) return;
      settled = true;
      pendingResolvers.delete(pendingId);
      clearTimeout(timer);
      resolve(decision);
    };
    pendingResolvers.set(pendingId, onResolve);
    const timer = setTimeout(() => {
      onResolve({ event: 'PreToolUse', permissionDecision: 'ask', reason: 'timeout' });
    }, timeoutMs);
  });
}

export function resolvePending(pendingId: string, decision: HookDecision): boolean {
  const r = pendingResolvers.get(pendingId);
  if (!r) return false;
  r(decision);
  return true;
}
