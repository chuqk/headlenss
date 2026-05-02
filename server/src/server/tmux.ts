import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/** `~/...` や相対パスをホーム基準で絶対パスに解決 */
function resolveCwd(input: string): string {
  const home = process.env.HOME ?? '/';
  if (input === '~') return home;
  if (input.startsWith('~/')) return path.join(home, input.slice(2));
  if (path.isAbsolute(input)) return input;
  return path.join(home, input);
}

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

/**
 * tmux サーバ・セッションを headless ブラウザビューに最適化する設定を流す。
 * Claude Code 公式ドキュメント (code.claude.com/docs/en/terminal-config) で必須とされる
 * 3 設定をベースに、headlenss 固有の mouse/status を加えたもの。
 *
 *  - allow-passthrough on : 通知/プログレスバーを外側端末まで通す (Claude Code向け)
 *  - extended-keys on     : Shift+Enter 等の拡張キーを認識させる
 *  - terminal-features 'xterm*:extkeys'
 *                         : 外側端末が CSI u を受理できる旨を tmux に通知
 *                          (これが無いと extended-keys が pane へ伝わらない)
 *  - mouse off            : ホイールを tmux に取られず、ブラウザ側 xterm.js scrollback を効かせる
 *  - status off           : ステータスバーは Web UI で別表示するため非表示
 */
export async function configureSessionForHeadless(name: string): Promise<void> {
  validateName(name);
  // global / server option (全セッション共通)
  try { await exec('tmux', ['set', '-g', 'allow-passthrough', 'on']); } catch { /* ignore */ }
  try { await exec('tmux', ['set', '-s', 'extended-keys', 'on']); } catch { /* ignore */ }
  try { await exec('tmux', ['set', '-as', 'terminal-features', 'xterm*:extkeys']); } catch { /* ignore */ }
  // session option
  try { await exec('tmux', ['set', '-t', name, 'mouse', 'off']); } catch { /* ignore */ }
  try { await exec('tmux', ['set', '-t', name, 'status', 'off']); } catch { /* ignore */ }
}

export type CreateSessionOptions = {
  /** セッション開始時の作業ディレクトリ。`~`、`~/...`、相対パスはホーム基準で展開。
   *  ディレクトリが存在しなければ mkdir -p で作成する。 */
  cwd?: string;
  /** true なら新規シェル上で `claude -c || claude` を実行する (claude code 起動)。
   *  `claude -c` は過去会話の継続。失敗時 (該当会話無し等) は通常 `claude` にフォールバック。 */
  startClaude?: boolean;
};

export async function createSession(
  name: string,
  options: CreateSessionOptions = {},
): Promise<void> {
  validateName(name);
  const home = process.env.HOME ?? '/';
  const targetCwd = options.cwd ? resolveCwd(options.cwd) : home;

  // cwd が指定されていれば作成 (存在すれば no-op、recursive: true なので親ごと作る)
  if (options.cwd) {
    try {
      await mkdir(targetCwd, { recursive: true });
    } catch (e) {
      throw new Error(`failed to create cwd "${targetCwd}": ${(e as Error).message}`);
    }
  }

  await exec('tmux', ['new-session', '-d', '-c', targetCwd, '-s', name], { cwd: targetCwd });
  await configureSessionForHeadless(name);

  if (options.startClaude) {
    // 新セッションのシェルがプロンプト準備完了するまで少し待つ
    await new Promise((r) => setTimeout(r, 300));
    // `claude -c` で過去会話継続を試み、失敗した場合は通常起動にフォールバック。
    // shell の `||` で分岐するので、bash/zsh/fish の最近のバージョンで動く。
    await sendKeys(name, 'claude -c || claude', true);
  }
}

/** セッションが無ければ作る (新規作成時は headless 用に設定する) */
export async function ensureSession(name: string): Promise<void> {
  validateName(name);
  try {
    await exec('tmux', ['has-session', '-t', name]);
    // 既存: 念のため設定を当て直す
    await configureSessionForHeadless(name);
  } catch {
    await createSession(name);
  }
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
