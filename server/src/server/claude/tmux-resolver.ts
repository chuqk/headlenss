import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export async function resolveTmuxSessionName(pane: string): Promise<string> {
  if (!pane) return '';
  if (!/^%[0-9]+$/.test(pane)) return '';
  try {
    const { stdout } = await exec('tmux', [
      'display-message',
      '-t', pane,
      '-p',
      '#{session_name}:#{window_name}',
    ]);
    return stdout.trim();
  } catch {
    return '';
  }
}
