export type ChatRole = 'user' | 'assistant';

export type ChatItem = {
  role: ChatRole;
  text: string;
  ts: number;
  /** サーバ側で動的に注入した「合成メッセージ」(transcript には永続化されない、
   *  状態通知用などに使われる)。クライアントは true なら表示有無を選べる。 */
  synthetic?: boolean;
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
  /** Stop hook 受信時刻。次の user-prompt-submit が来るまで「ターン終了済み」フラグとして使う。
   *  registry の busy が遅れて idle に追いつかない時、考え中インジケータを早めに消すために参照。 */
  lastStopAt?: number;
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
