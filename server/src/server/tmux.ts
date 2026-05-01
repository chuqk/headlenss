import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export type Session = {
  name: string;
  created: number;
  windows: number;
  attached: boolean;
};

const NAME_RE = /^[a-zA-Z0-9_-]{1,40}$/;

export function validateName(name: string): void {
  if (!NAME_RE.test(name)) {
    throw new Error('invalid session name (use [a-zA-Z0-9_-], max 40 chars)');
  }
}

export async function listSessions(): Promise<Session[]> {
  try {
    const { stdout } = await exec('tmux', [
      'list-sessions',
      '-F',
      '#{session_name}\t#{session_created}\t#{session_windows}\t#{session_attached}',
    ]);
    return stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [name, created, windows, attached] = line.split('\t');
        return {
          name,
          created: Number(created) * 1000,
          windows: Number(windows),
          attached: Number(attached) > 0,
        };
      });
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr ?? '';
    if (stderr.includes('no server running') || stderr.includes('error connecting')) return [];
    throw err;
  }
}

export async function createSession(name: string): Promise<void> {
  validateName(name);
  const home = process.env.HOME ?? '/';
  await exec('tmux', ['new-session', '-d', '-c', home, '-s', name], { cwd: home });
}

export async function killSession(name: string): Promise<void> {
  validateName(name);
  await exec('tmux', ['kill-session', '-t', name]);
}

export async function sendKeys(name: string, text: string, submit = false): Promise<void> {
  validateName(name);
  if (text.length > 0) {
    await exec('tmux', ['send-keys', '-t', name, '-l', text]);
  }
  if (submit) {
    await exec('tmux', ['send-keys', '-t', name, 'Enter']);
  }
}

/**
 * セッションのアクティブpaneを capture-pane でテキスト化して返す。
 * `-p` stdout出力 / `-J` 折り返し行を結合 / `-S -<lines>` で開始行を相対指定。
 * 色エスケープは付かない (`-e` を渡さない)。
 */
export async function captureOutput(name: string, lines = 24): Promise<string> {
  validateName(name);
  const safeLines = Math.max(1, Math.min(2000, Math.floor(lines)));
  const { stdout } = await exec('tmux', [
    'capture-pane',
    '-t', name,
    '-p',
    '-J',
    '-S', `-${safeLines}`,
  ]);
  return stdout;
}
