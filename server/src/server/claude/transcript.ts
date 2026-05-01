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
