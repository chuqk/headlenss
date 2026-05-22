import { readFile } from 'node:fs/promises';

type TranscriptLine = {
  type?: string;
  message?: { role?: string; content?: unknown };
  role?: string;
  content?: unknown;
};

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === 'object') {
      const obj = block as { type?: string; text?: unknown };
      if (obj.type === 'text' && typeof obj.text === 'string') {
        parts.push(obj.text);
      }
    }
  }
  return parts.join('').trim();
}

type ContentBlock = { type?: string; text?: unknown; content?: unknown };

/**
 * Claude Code の transcript に含まれるシステムタグを人間向けにクリーニングする。
 *  - `<local-command-caveat>...</local-command-caveat>` : 内部用キャプション、完全削除
 *  - `<system-reminder>...</system-reminder>`           : 内部用注意書き、完全削除
 *  - `<bash-input>X</bash-input>`                       : `$ X` に変換
 *  - `<bash-stdout>X</bash-stdout>`                     : 中身だけ残す
 *  - `<bash-stderr>X</bash-stderr>`                     : 中身だけ残す
 *  - `<command-name>X</command-name>` を含むメッセージ  : メッセージ全体を `/X args`
 *    だけに収束 (skill 本体のテキストは捨てる)
 *  - 連続改行を 2 行までに圧縮
 */
export function sanitizeChatText(text: string): string {
  // <command-name> を含む user メッセージは「ユーザが /foo を打ち込んだ」直後に
  // skill 本体が展開された結果なので、本体テキストは表示せず、コマンド名だけ残す。
  // (例: /commit-ai を打つと長大な skill 説明が記録される → 履歴で見たいのは /commit-ai だけ)
  const cmdNameMatch = text.match(/<command-name>([\s\S]*?)<\/command-name>/);
  if (cmdNameMatch) {
    const cmdName = cmdNameMatch[1].trim();
    const cmdArgsMatch = text.match(/<command-args>([\s\S]*?)<\/command-args>/);
    const cmdArgs = cmdArgsMatch ? cmdArgsMatch[1].trim() : '';
    return cmdArgs ? `${cmdName} ${cmdArgs}` : cmdName;
  }

  let s = text;
  s = s.replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, '');
  s = s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '');
  s = s.replace(/<bash-input>([\s\S]*?)<\/bash-input>/g, (_, cmd: string) => `$ ${cmd.trim()}`);
  s = s.replace(/<bash-stdout>([\s\S]*?)<\/bash-stdout>/g, '$1');
  s = s.replace(/<bash-stderr>([\s\S]*?)<\/bash-stderr>/g, '$1');
  // 念のため他の <foo>...</foo> 系も剥がす(残ると意味不明になる)。
  // ただし transcript 中にユーザが意図的に書いた XML/HTML タグは保持したいので、
  // 既知のラッパに限定し、上記で対応済み。残るのは plain text のはず。
  s = s.replace(/\n{3,}/g, '\n\n').trim();
  return s;
}

/** Claude Code がサブエージェント (Task tool) の完了を親エージェントに伝える時、
 *  API 仕様上 role=user として `<task-notification>...</task-notification>` で
 *  包んで transcript に書き込む。これは本物のユーザ入力ではないので Chat UI 上は
 *  AI 側 (assistant) に振り分けたい。
 *
 *  誤検知防止のため「開始タグ・<task-id>・終了タグ」の3点セットが全部揃った
 *  完全な構造を要求する。ユーザが文中に `<task-notification>` という文字列を
 *  単に書いた程度では絶対にマッチしない。 */
const TASK_NOTIFICATION_RE =
  /^\s*<task-notification>[\s\S]*<task-id>[\s\S]*<\/task-notification>\s*$/;

function isTaskNotification(text: string): boolean {
  return TASK_NOTIFICATION_RE.test(text);
}

/** <task-notification> ペイロードから人間が読みやすい本文を組み立てる。
 *  <task-id> / <tool-use-id> / <output-file> 等の機械用 ID は捨て、<summary> と
 *  <result> だけ残す。<status> が completed 以外ならその旨を頭に付ける。 */
function formatTaskNotification(text: string): string {
  const get = (tag: string): string =>
    text.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`))?.[1].trim() ?? '';
  const summary = get('summary');
  const status = get('status');
  const result = get('result');
  const header = summary ? `**[サブエージェント] ${summary}**` : '**[サブエージェント]**';
  const statusLine = status && status !== 'completed' ? `_status: ${status}_\n\n` : '';
  return result
    ? `${header}\n\n${statusLine}${result}`
    : `${header}${statusLine ? '\n\n' + statusLine : ''}`;
}

/**
 * transcript JSONL からチャット履歴 (user prompt と assistant text) を順序通りに抽出する。
 * - tool_result / tool_use ブロックは除外
 * - sub-agent (isSidechain=true) は除外
 * - <task-notification> wrapper は role を assistant に振り替えて整形
 * - limit: 末尾 N 件のみ返す (デフォルト 200)
 */
export async function extractChatFromTranscript(
  transcriptPath: string,
  limit = 200,
): Promise<Array<{ role: 'user' | 'assistant'; text: string; ts: number }>> {
  if (!transcriptPath) return [];
  let raw: string;
  try {
    raw = await readFile(transcriptPath, 'utf-8');
  } catch {
    return [];
  }
  const items: Array<{ role: 'user' | 'assistant'; text: string; ts: number }> = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let parsed: TranscriptLine & { isSidechain?: boolean; timestamp?: string };
    try {
      parsed = JSON.parse(line) as typeof parsed;
    } catch {
      continue;
    }
    if (parsed.isSidechain === true) continue;
    const role = parsed.message?.role ?? parsed.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const content = parsed.message?.content ?? parsed.content;
    let text = '';
    if (typeof content === 'string') {
      // user prompt の plain string ケース
      text = content.trim();
    } else if (Array.isArray(content)) {
      const parts: string[] = [];
      let hasOnlyTool = true;
      for (const block of content as ContentBlock[]) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'text' && typeof block.text === 'string') {
          parts.push(block.text);
          hasOnlyTool = false;
        } else if (block.type === 'tool_use' || block.type === 'tool_result') {
          // skip
        } else {
          hasOnlyTool = false;
        }
      }
      // tool_result / tool_use のみで text が無いものはチャットに出さない
      if (hasOnlyTool) continue;
      text = parts.join('').trim();
    }
    if (!text) continue;
    // <task-notification> wrapper の判定はサニタイズ前に行う (sanitizeChatText が
    // 未知タグの中身だけ残す処理を入れる可能性に備える)。マッチしたら role を
    // assistant に上書きし、本文も summary/result だけの整形版に置換する。
    let effectiveRole: 'user' | 'assistant' = role as 'user' | 'assistant';
    let effectiveText = text;
    if (effectiveRole === 'user' && isTaskNotification(text)) {
      effectiveRole = 'assistant';
      effectiveText = formatTaskNotification(text);
    }
    const cleaned = sanitizeChatText(effectiveText);
    if (!cleaned) continue;
    const ts = parsed.timestamp ? Date.parse(parsed.timestamp) : Date.now();
    items.push({ role: effectiveRole, text: cleaned, ts: Number.isFinite(ts) ? ts : Date.now() });
  }
  return items.slice(-limit);
}

/**
 * Extract the most recent assistant message text from a Claude Code transcript JSONL file.
 * Returns empty string if not found or unreadable.
 */
export async function extractLastAssistantText(transcriptPath: string): Promise<string> {
  if (!transcriptPath) return '';
  let raw: string;
  try {
    raw = await readFile(transcriptPath, 'utf-8');
  } catch {
    return '';
  }
  const lines = raw.split('\n').filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    let parsed: TranscriptLine;
    try {
      parsed = JSON.parse(lines[i]) as TranscriptLine;
    } catch {
      continue;
    }
    const role = parsed.message?.role ?? parsed.role;
    if (role !== 'assistant') continue;
    const content = parsed.message?.content ?? parsed.content;
    const text = extractText(content);
    if (text) return text;
  }
  return '';
}
