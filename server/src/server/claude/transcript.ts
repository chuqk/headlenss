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
 * transcript JSONL からチャット履歴 (user prompt と assistant text) を順序通りに抽出する。
 * - tool_result / tool_use ブロックは除外
 * - sub-agent (isSidechain=true) は除外
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
    const ts = parsed.timestamp ? Date.parse(parsed.timestamp) : Date.now();
    items.push({ role: role as 'user' | 'assistant', text, ts: Number.isFinite(ts) ? ts : Date.now() });
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
