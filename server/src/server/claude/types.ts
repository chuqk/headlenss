export type ChatRole = 'user' | 'assistant';

export type ChatItem = {
  role: ChatRole;
  text: string;
  ts: number;
};

export type SessionStatus = 'idle' | 'busy' | 'waiting-permission' | 'waiting-question';

export type AskQuestionOption = {
  label: string;
  description?: string;
};

export type AskQuestion = {
  header?: string;
  question: string;
  multiSelect?: boolean;
  options?: AskQuestionOption[];
};

export type Pending = {
  id: string;
  kind: 'permission' | 'question';
  hookEvent: 'PreToolUse' | 'PermissionRequest';
  toolName: string;
  toolInput: unknown;
  questions?: AskQuestion[];
  createdAt: number;
};

export type ClaudeSession = {
  ccSessionId: string;
  tmuxPane: string;
  tmuxSessionName: string;
  cwd: string;
  status: SessionStatus;
  startedAt: number;
  lastSeenAt: number;
  chat: ChatItem[];
  pending?: Pending;
};

export type HookHeaders = {
  tmuxPane: string;
  tmux?: string;
};

export type RespondInput =
  | { kind: 'permission'; decision: 'allow' | 'deny'; message?: string }
  | { kind: 'question'; answers: Array<{ question: string; option: string }> };

export type HookDecision =
  | { event: 'PreToolUse'; permissionDecision: 'allow' | 'deny' | 'ask'; reason?: string }
  | { event: 'PermissionRequest'; behavior: 'allow' | 'deny'; message?: string };
