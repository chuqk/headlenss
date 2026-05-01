import { Hono } from 'hono';
import type { Context } from 'hono';
import * as store from './store.ts';
import { resolveTmuxSessionName } from './tmux-resolver.ts';
import { extractLastAssistantText } from './transcript.ts';
import type { AskQuestion, HookDecision, RespondInput } from './types.ts';

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
  const tmuxName = await getTmuxName(c);
  if (tmuxName) store.removeSession(tmuxName);
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
  const text = (body.prompt ?? '').trim();
  if (text) store.appendChat(tmuxName, 'user', text);
  return c.json({});
});

claudeRouter.post('/hooks/stop', async (c) => {
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
  const transcriptPath = body.transcript_path ?? '';
  if (transcriptPath) {
    const text = await extractLastAssistantText(transcriptPath);
    if (text) store.appendChat(tmuxName, 'assistant', text);
  }
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

claudeRouter.get('/claude/sessions', (c) => {
  const sessions = store.listSessions().map((s) => ({
    tmuxSessionName: s.tmuxSessionName,
    cwd: s.cwd,
    status: s.status,
    startedAt: s.startedAt,
    lastSeenAt: s.lastSeenAt,
  }));
  return c.json({ sessions });
});

claudeRouter.get('/claude/sessions/:tmuxName/chat', (c) => {
  const tmuxName = c.req.param('tmuxName');
  const session = store.getSession(tmuxName);
  if (!session) return c.json({ error: 'not found' }, 404);
  return c.json({ chat: session.chat });
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
