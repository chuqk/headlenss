import { execFile } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import * as claudeStore from './claude/store.ts';
import { detectClaudeSessions } from './claude/process-detect.ts';
import { createSession } from './tmux.ts';

const exec = promisify(execFile);

/**
 * 復元用スナップショット保存先。XDG 準拠 (XDG_CONFIG_HOME or ~/.config/headlenss)。
 * subuntu 再起動を跨いで「直前にどの tmux セッションが、どの cwd で、claude code 起動中だったか」
 * を記録するためのファイル。
 */
const CONFIG_DIR = process.env.XDG_CONFIG_HOME
  ? resolve(process.env.XDG_CONFIG_HOME, 'headlenss')
  : resolve(homedir(), '.config/headlenss');
const SNAPSHOT_PATH = resolve(CONFIG_DIR, 'sessions.json');

type SnapshotEntry = {
  tmuxSessionName: string;
  cwd: string;
  hasClaude: boolean;
};

type SnapshotFile = {
  version: 1;
  savedAt: number;
  sessions: SnapshotEntry[];
};

/**
 * `tmux list-panes -a` で「セッション名 → 代表 pane の current_path」マップを作る。
 * tmux server が無い (正常): 空 Map を返す。tmux 自体が異常: null を返してスナップショットを更新させない。
 */
async function readTmuxSnapshot(): Promise<Map<string, string> | null> {
  try {
    const { stdout } = await exec('tmux', [
      'list-panes',
      '-a',
      '-F',
      '#{session_name}\t#{pane_current_path}',
    ]);
    const byName = new Map<string, string>();
    for (const line of stdout.split('\n')) {
      if (!line.trim()) continue;
      const [name, cwd] = line.split('\t');
      // 同一セッション内の複数 pane は最初の 1 つを採用 (代表 pane)
      if (!byName.has(name)) byName.set(name, cwd ?? '');
    }
    return byName;
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr ?? '';
    if (stderr.includes('no server running') || stderr.includes('error connecting')) {
      return new Map();
    }
    console.warn(`[persist] tmux list-panes failed: ${(err as Error).message}`);
    return null;
  }
}

/**
 * 現在の tmux 状態 + claude セッション情報をスナップショットファイルに書き出す。
 * tmux 異常時は既存ファイルを上書きしない (空で潰さない)。書き込みは tmp → rename で原子化。
 */
export async function saveSnapshot(): Promise<void> {
  const tmuxMap = await readTmuxSnapshot();
  if (tmuxMap === null) return;

  // claude code が動いている tmux セッションの集合を作る。
  // 2 系統を OR でマージする:
  //   1) claudeStore.listSessions() ─ プラグインの hook (SessionStart 等) で登録されたもの
  //   2) detectClaudeSessions() ─ ~/.claude/sessions/ レジストリから検出されたもの (hook が
  //      何らかの理由で届かない時のフォールバック。/api/claude/sessions も同じ 2 系統マージ)
  // 1 だけだと、tmux pane 内で `claude` を手動起動して plugin の hook が届かない場合
  // hasClaude=false で保存されて restart 越しに claude が再起動されない、というバグになる
  // (実機で再現確認済)。
  const claudeNames = new Set<string>(
    claudeStore.listSessions().map((s) => s.tmuxSessionName),
  );
  try {
    const detected = await detectClaudeSessions();
    for (const d of detected) claudeNames.add(d.tmuxSessionName);
  } catch (e) {
    console.warn(`[persist] detectClaudeSessions failed in saveSnapshot: ${(e as Error).message}`);
  }

  // セッションの cwd は「起動場所を維持する」ポリシー:
  // - 既に snapshot に記録されているセッションは、その cwd を保持する (ユーザが
  //   pane 内で `cd` しても、起動時の場所として記録した cwd を上書きしない)。
  // - 既存になければ (= 新規セッション) は pane_current_path をそのまま採用する。
  // これは「test を /tmp/foo で立てて、 pane 内で cd ~ したら restart で
  // /home/sato で復元されてしまった」というユーザ報告への対処。
  const previousCwd = new Map<string, string>();
  try {
    const prev = await loadSnapshot();
    for (const e of prev) previousCwd.set(e.tmuxSessionName, e.cwd);
  } catch { /* ignore: 初回は空でOK */ }

  const sessions: SnapshotEntry[] = [];
  for (const [name, currentCwd] of tmuxMap) {
    const cwd = previousCwd.get(name) ?? currentCwd;
    sessions.push({
      tmuxSessionName: name,
      cwd,
      hasClaude: claudeNames.has(name),
    });
  }

  const file: SnapshotFile = {
    version: 1,
    savedAt: Date.now(),
    sessions,
  };

  try {
    await mkdir(CONFIG_DIR, { recursive: true });
    const tmp = `${SNAPSHOT_PATH}.tmp`;
    await writeFile(tmp, JSON.stringify(file, null, 2));
    await rename(tmp, SNAPSHOT_PATH);
  } catch (e) {
    console.warn(`[persist] saveSnapshot failed: ${(e as Error).message}`);
  }
}

async function loadSnapshot(): Promise<SnapshotEntry[]> {
  try {
    const raw = await readFile(SNAPSHOT_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as SnapshotFile;
    if (parsed.version !== 1 || !Array.isArray(parsed.sessions)) return [];
    return parsed.sessions.filter(
      (e): e is SnapshotEntry =>
        typeof e?.tmuxSessionName === 'string' &&
        typeof e?.cwd === 'string' &&
        typeof e?.hasClaude === 'boolean',
    );
  } catch {
    return [];
  }
}

/**
 * サーバ起動時に呼ぶ復元処理。
 *
 * - スナップショットファイルを読み、各エントリについて tmux セッションを再生成する
 * - 既に同名のセッションが立っていればスキップ (重複作成しない)
 * - `hasClaude: true` のセッションは `claude -c` も走らせる (createSession 内部で env による
 *   resume-prompt 抑止と TUI フォールバックが効く)
 * - 各セッションは直列に起動する (claude 起動が並列で重なるのを避けるため)
 *
 * 個別の失敗は warn ログを出して次へ進む。
 */
export async function restoreSessions(): Promise<void> {
  const entries = await loadSnapshot();
  if (entries.length === 0) {
    console.log('[persist] no snapshot to restore');
    return;
  }

  const current = await readTmuxSnapshot();
  const existing = new Set<string>(current ? current.keys() : []);

  console.log(
    `[persist] restoring ${entries.length} session(s) from ${SNAPSHOT_PATH}`,
  );

  for (const entry of entries) {
    if (existing.has(entry.tmuxSessionName)) {
      console.log(`[persist] skip ${entry.tmuxSessionName} (already running)`);
      continue;
    }
    console.log(
      `[persist] restore ${entry.tmuxSessionName} cwd=${entry.cwd} claude=${entry.hasClaude}`,
    );
    try {
      await createSession(entry.tmuxSessionName, {
        cwd: entry.cwd || undefined,
        startClaude: entry.hasClaude,
      });
    } catch (e) {
      console.warn(
        `[persist] restore ${entry.tmuxSessionName} failed: ${(e as Error).message}`,
      );
    }
  }
}

let persistTimer: ReturnType<typeof setInterval> | null = null;

/**
 * 定期スナップショット。事故起動 (停電・OOM kill 等) で API hook が走らずに死んだ場合の保険。
 * 通常は createSession / killSession 直後の saveSnapshot() でカバーできる。
 */
export function startPeriodicSnapshot(intervalMs = 30000): void {
  if (persistTimer) return;
  persistTimer = setInterval(() => {
    void saveSnapshot();
  }, intervalMs);
}
