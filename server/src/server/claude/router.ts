import { Hono } from 'hono';
import type { Context } from 'hono';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve as pathResolve } from 'node:path';
import { promisify } from 'node:util';
import { detectClaudeSessions } from './process-detect.ts';
import * as store from './store.ts';
import { resolveTmuxSessionName } from './tmux-resolver.ts';
import { extractChatFromTranscript, extractLastAssistantText, sanitizeChatText } from './transcript.ts';
import type { AskQuestion, HookDecision, RespondInput, SessionStatus } from './types.ts';

const exec = promisify(execFile);

/** 現在 tmux server 上に存在しているセッション名集合を返す */
async function liveTmuxSessionNames(): Promise<Set<string>> {
  try {
    const { stdout } = await exec('tmux', ['list-sessions', '-F', '#{session_name}']);
    return new Set(stdout.trim().split('\n').filter(Boolean));
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr ?? '';
    // tmux server が居ない = セッション無し
    if (stderr.includes('no server running') || stderr.includes('error connecting')) {
      return new Set();
    }
    // それ以外のエラーは安全側として空集合扱いはせず投げる
    throw err;
  }
}

/** cwd と sessionId から transcript ファイルのパスを推定する */
function transcriptPathFor(cwd: string, sessionId: string): string {
  const encoded = cwd.replace(/\//g, '-');
  return pathResolve(homedir(), '.claude/projects', encoded, `${sessionId}.jsonl`);
}

export const claudeRouter = new Hono();

const PENDING_TIMEOUT_MS = 600_000;

async function getTmuxName(c: Context): Promise<string> {
  const pane = c.req.header('X-Tmux-Pane') ?? '';
  return resolveTmuxSessionName(pane);
}

type HookPayload = {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  prompt?: string;
  tool_name?: string;
  tool_input?: { questions?: AskQuestion[]; [k: string]: unknown };
  source?: string;
};

// ───────── hooks (received from plugin) ─────────

claudeRouter.post('/hooks/session-start', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as HookPayload;
  const tmuxName = await getTmuxName(c);
  console.log(`[hook] session-start tmux=${tmuxName} src=${body.source ?? ''}`);
  if (!tmuxName) return c.json({});
  store.upsertSession({
    ccSessionId: body.session_id ?? '',
    tmuxPane: c.req.header('X-Tmux-Pane') ?? '',
    tmuxSessionName: tmuxName,
    cwd: body.cwd ?? '',
  });
  return c.json({});
});

claudeRouter.post('/hooks/session-end', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as HookPayload;
  const tmuxName = await getTmuxName(c);
  console.log(`[hook] session-end tmux=${tmuxName} src=${body.source ?? ''} (NOT clearing chat)`);
  // 注意: SessionEnd は prompt_input_exit など軽い理由でも発火するため、
  // ここで session を削除すると chat 履歴がリセットされて壊れる。
  // 起動中判定はレジストリ検出 (process-detect) に任せ、ここでは何もしない。
  return c.json({});
});

claudeRouter.post('/hooks/user-prompt-submit', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as HookPayload;
  const tmuxName = await getTmuxName(c);
  if (!tmuxName) return c.json({});
  // Lazy-create the session if SessionStart hook never fired
  if (!store.getSession(tmuxName)) {
    store.upsertSession({
      ccSessionId: body.session_id ?? '',
      tmuxPane: c.req.header('X-Tmux-Pane') ?? '',
      tmuxSessionName: tmuxName,
      cwd: body.cwd ?? '',
    });
  }
  // 新しいターンが始まる: 前ターンの Stop マーカーをクリア
  store.clearStopped(tmuxName);
  const text = (body.prompt ?? '').trim();
  console.log(`[hook] user-prompt tmux=${tmuxName} len=${text.length}`);
  if (text) store.appendChat(tmuxName, 'user', text);
  return c.json({});
});

claudeRouter.post('/hooks/stop', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as HookPayload;
  const tmuxName = await getTmuxName(c);
  console.log(`[hook] stop tmux=${tmuxName} transcript=${(body.transcript_path ?? '').slice(-40)}`);
  if (!tmuxName) return c.json({});
  if (!store.getSession(tmuxName)) {
    store.upsertSession({
      ccSessionId: body.session_id ?? '',
      tmuxPane: c.req.header('X-Tmux-Pane') ?? '',
      tmuxSessionName: tmuxName,
      cwd: body.cwd ?? '',
    });
  }
  const transcriptPath = body.transcript_path ?? '';
  if (transcriptPath) {
    const text = await extractLastAssistantText(transcriptPath);
    console.log(`[hook] stop -> assistant text len=${text.length}`);
    if (text) store.appendChat(tmuxName, 'assistant', text);
  }
  // ターン終了マーカーを立てる: registry の busy が idle に追いつくまでの
  // ラグの間、考え中インジケータをこちらで先に消す。
  store.markStopped(tmuxName);
  return c.json({});
});

claudeRouter.post('/hooks/pre-tool-use', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as HookPayload;
  const tmuxName = await getTmuxName(c);
  if (!tmuxName) return c.json({});
  if (!store.getSession(tmuxName)) {
    store.upsertSession({
      ccSessionId: body.session_id ?? '',
      tmuxPane: c.req.header('X-Tmux-Pane') ?? '',
      tmuxSessionName: tmuxName,
      cwd: body.cwd ?? '',
    });
  }

  const toolName = body.tool_name ?? '';
  const toolInput = body.tool_input ?? {};
  const isAskQ = toolName === 'AskUserQuestion' && Array.isArray(toolInput.questions);

  const pending = store.createPending(tmuxName, {
    kind: isAskQ ? 'question' : 'permission',
    hookEvent: 'PreToolUse',
    toolName,
    toolInput,
    questions: isAskQ ? toolInput.questions : undefined,
  });

  const decision = await store.awaitPendingResolution(pending.id, PENDING_TIMEOUT_MS);
  store.clearPending(tmuxName);

  if (decision.event === 'PreToolUse') {
    return c.json({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: decision.permissionDecision,
        permissionDecisionReason: decision.reason,
      },
    });
  }
  return c.json({});
});

claudeRouter.post('/hooks/permission-request', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as HookPayload;
  const tmuxName = await getTmuxName(c);
  if (!tmuxName) return c.json({});
  if (!store.getSession(tmuxName)) {
    store.upsertSession({
      ccSessionId: body.session_id ?? '',
      tmuxPane: c.req.header('X-Tmux-Pane') ?? '',
      tmuxSessionName: tmuxName,
      cwd: body.cwd ?? '',
    });
  }

  const toolName = body.tool_name ?? '';
  const toolInput = body.tool_input ?? {};
  const isAskQ = toolName === 'AskUserQuestion' && Array.isArray(toolInput.questions);

  const pending = store.createPending(tmuxName, {
    kind: isAskQ ? 'question' : 'permission',
    hookEvent: 'PermissionRequest',
    toolName,
    toolInput,
    questions: isAskQ ? toolInput.questions : undefined,
  });

  const decision = await store.awaitPendingResolution(pending.id, PENDING_TIMEOUT_MS);
  store.clearPending(tmuxName);

  if (decision.event === 'PermissionRequest') {
    return c.json({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: decision.behavior, message: decision.message },
      },
    });
  }
  return c.json({});
});

// ───────── G2-facing endpoints ─────────

claudeRouter.get('/claude/sessions', async (c) => {
  // hook 経由で記録されているセッション (チャット履歴あり)
  const tracked = store.listSessions();

  // 現在生きている tmux セッションを取得し、tracked のうち既に消滅したものは
  // store からも消す (DELETE API 以外の経路で kill された場合への保険)。
  // tmux 側の取得に失敗した場合は cleanup 自体をスキップして既存挙動を維持する。
  let liveTmux: Set<string> | null = null;
  try {
    liveTmux = await liveTmuxSessionNames();
  } catch {
    liveTmux = null;
  }
  if (liveTmux) {
    for (const s of tracked) {
      if (!liveTmux.has(s.tmuxSessionName)) {
        store.removeSession(s.tmuxSessionName);
      }
    }
  }

  // 掃除後の tracked 一覧を取り直す
  const trackedAlive = liveTmux ? store.listSessions() : tracked;
  const trackedNames = new Set(trackedAlive.map((s) => s.tmuxSessionName));

  // ~/.claude/sessions/ レジストリから検出 (プラグインなしでも検出可)
  const detected = await detectClaudeSessions();

  const merged: Array<{
    tmuxSessionName: string;
    cwd: string;
    status: SessionStatus;
    startedAt: number;
    lastSeenAt: number;
  }> = [];

  for (const s of trackedAlive) {
    merged.push({
      tmuxSessionName: s.tmuxSessionName,
      cwd: s.cwd,
      status: s.status,
      startedAt: s.startedAt,
      lastSeenAt: s.lastSeenAt,
    });
  }

  for (const d of detected) {
    if (trackedNames.has(d.tmuxSessionName)) continue;
    // detect 側にも tmux 居るかフィルタ (process-detect は tmux pane 紐付け済なので
    // 通常はOKだが、念のため)
    if (liveTmux && !liveTmux.has(d.tmuxSessionName)) continue;
    merged.push({
      tmuxSessionName: d.tmuxSessionName,
      cwd: d.cwd,
      status: d.status,
      startedAt: d.startedAt,
      lastSeenAt: d.startedAt,
    });
  }

  return c.json({ sessions: merged });
});

claudeRouter.get('/claude/sessions/:tmuxName/chat', async (c) => {
  const tmuxName = c.req.param('tmuxName');
  const session = store.getSession(tmuxName);

  // 現在動いてる Claude Code を registry から探して transcript path を割り出す
  const detected = await detectClaudeSessions();
  const det = detected.find((d) => d.tmuxSessionName === tmuxName);

  // hook 経由で記録された chat
  const hookChat = session?.chat ?? [];

  // transcript を読んで履歴を補完 (hook では取りこぼす過去分も拾える)
  let transcriptChat: Array<{ role: 'user' | 'assistant'; text: string; ts: number }> = [];
  if (det && det.cwd && det.ccSessionId) {
    const path = transcriptPathFor(det.cwd, det.ccSessionId);
    if (existsSync(path)) {
      transcriptChat = await extractChatFromTranscript(path, 200);
    }
  }

  // hook 由来の chat も transcript と同じシステムタグサニタイズを通す
  // (! 付きで実行された bash コマンド等のラッパが残らないように)。
  const cleanedHookChat = hookChat
    .map((m) => ({ ...m, text: sanitizeChatText(m.text) }))
    .filter((m) => m.text.length > 0);

  // hook の最新分が transcript から漏れてる可能性に備えてマージ。
  // transcript を base にして、hook側の項目を text 一致で重複排除。
  const seen = new Set(transcriptChat.map((m) => `${m.role}:${m.text}`));
  const merged = [...transcriptChat];
  for (const m of cleanedHookChat) {
    const key = `${m.role}:${m.text}`;
    if (!seen.has(key)) merged.push(m);
  }

  if (merged.length === 0 && !session) {
    return c.json({ error: 'not found' }, 404);
  }
  // Claude Code の動作状態 (idle / busy / waiting-*) を一緒に返して、
  // chat UI 側で「考え中…」表示の有無を制御できるようにする。
  //
  // 優先順位の根拠:
  //   - 'waiting-*' は hook 経由(PermissionRequest/PreToolUse)でしか設定されない
  //   - 'busy' は registry (~/.claude/sessions/<PID>.json) 経由でしか検出されない
  //   - 'idle' はそれ以外
  // hook session.status は常に 'idle' か 'waiting-*' (busy になる経路がない)ため、
  // 単純な ?? チェーンでは registry 由来の 'busy' が永遠に拾われない。merge する。
  let status: SessionStatus = 'idle';
  if (det?.status === 'busy') status = 'busy';
  if (session?.status === 'waiting-permission' || session?.status === 'waiting-question') {
    status = session.status;
  }
  // Stop hook が直近で発火していれば「ターン終了済み」なので busy を抑止。
  // 次の user-prompt-submit が来るまではこのフラグが残り続け、registry が
  // idle に追いつくまでの数秒間に「考え中」が残ってしまう問題を消す。
  if (status === 'busy' && session?.lastStopAt) {
    status = 'idle';
  }

  // G2 アプリは status フィールドを読まない(描画は chat 配列だけ)ので、
  // 状態を 1 行のメッセージとして合成 chat 末尾に注入。`synthetic: true` を立てて
  // 永続化用ではないことを示し、PC chat はこれをフィルタして dot インジケータと
  // 二重表示にしないようにする。アニメーションは Date.now ベースで dot 数を回す。
  if (status !== 'idle') {
    const dots = '.'.repeat((Math.floor(Date.now() / 500) % 3) + 1);
    const text =
      status === 'busy' ? `(考え中${dots})`
      : status === 'waiting-permission' ? `(許可待ち${dots})`
      : `(質問待ち${dots})`;
    merged.push({ role: 'assistant', text, ts: Date.now(), synthetic: true });
  }
  return c.json({ chat: merged, status });
});

claudeRouter.get('/claude/sessions/:tmuxName/pending', (c) => {
  const tmuxName = c.req.param('tmuxName');
  const pending = store.getPending(tmuxName);
  if (!pending) return c.json({ pending: null });
  return c.json({ pending });
});

claudeRouter.post('/claude/sessions/:tmuxName/respond', async (c) => {
  const tmuxName = c.req.param('tmuxName');
  const pending = store.getPending(tmuxName);
  if (!pending) return c.json({ error: 'no pending interaction' }, 404);

  const body = (await c.req.json().catch(() => null)) as RespondInput | null;
  if (!body) return c.json({ error: 'invalid body' }, 400);

  let decision: HookDecision;
  if (pending.hookEvent === 'PreToolUse') {
    if (body.kind === 'permission') {
      decision = {
        event: 'PreToolUse',
        permissionDecision: body.decision,
        reason: body.message,
      };
    } else if (body.kind === 'question') {
      const summary = body.answers
        .map((a) => `${a.question}: ${a.option}`)
        .join(' / ');
      decision = {
        event: 'PreToolUse',
        permissionDecision: 'deny',
        reason: `User answered: ${summary}`,
      };
    } else {
      return c.json({ error: 'invalid response kind' }, 400);
    }
  } else {
    if (body.kind === 'permission') {
      decision = {
        event: 'PermissionRequest',
        behavior: body.decision,
        message: body.message,
      };
    } else if (body.kind === 'question') {
      const summary = body.answers
        .map((a) => `${a.question}: ${a.option}`)
        .join(' / ');
      decision = {
        event: 'PermissionRequest',
        behavior: 'deny',
        message: `User answered: ${summary}`,
      };
    } else {
      return c.json({ error: 'invalid response kind' }, 400);
    }
  }

  const ok = store.resolvePending(pending.id, decision);
  if (!ok) return c.json({ error: 'pending not awaitable (already resolved or timed out)' }, 409);
  return c.json({ ok: true });
});
