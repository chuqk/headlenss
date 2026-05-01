import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export type DetectedSession = {
  pid: number;
  ccSessionId: string;
  cwd: string;
  startedAt: number;
  status: 'idle' | 'busy';
  tmuxSessionName: string;
};

type RegistryEntry = {
  pid?: number;
  sessionId?: string;
  cwd?: string;
  startedAt?: number;
  procStart?: string;
  status?: string;
};

/**
 * `~/.claude/sessions/<PID>.json` レジストリ(undocumented but reliable)を読んで
 * 生きている Claude Code プロセスを検出し、tmux session 名と紐付ける。
 */
export async function detectClaudeSessions(): Promise<DetectedSession[]> {
  const dir = resolve(homedir(), '.claude/sessions');
  if (!existsSync(dir)) return [];

  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }

  type Candidate = { entry: RegistryEntry; pid: number };
  const candidates: Candidate[] = [];

  for (const f of files) {
    const pid = Number(f.replace('.json', ''));
    if (!Number.isFinite(pid) || pid <= 0) continue;

    let entry: RegistryEntry;
    try {
      entry = JSON.parse(readFileSync(resolve(dir, f), 'utf-8')) as RegistryEntry;
    } catch {
      continue;
    }

    // PID 生存確認
    try {
      process.kill(pid, 0);
    } catch {
      continue;
    }

    // PID再利用検出: /proc/<pid>/stat の field22 (starttime) と procStart 一致
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8');
      const afterComm = stat.slice(stat.lastIndexOf(')') + 2);
      const fields = afterComm.split(' ');
      const starttime = fields[19]; // 1-indexed field 22 minus 3 (after pid + comm + state)
      if (entry.procStart && String(starttime) !== String(entry.procStart)) continue;
    } catch {
      // /proc を読めない (非Linux) ならスキップせず採用
    }

    candidates.push({ entry, pid });
  }

  if (candidates.length === 0) return [];

  const paneMap = await getTmuxPaneMap();
  const result: DetectedSession[] = [];

  for (const { entry, pid } of candidates) {
    const tmuxName = findTmuxAncestor(pid, paneMap);
    if (!tmuxName) continue;

    result.push({
      pid,
      ccSessionId: entry.sessionId ?? '',
      cwd: entry.cwd ?? '',
      startedAt: entry.startedAt ?? 0,
      status: entry.status === 'busy' ? 'busy' : 'idle',
      tmuxSessionName: tmuxName,
    });
  }

  return result;
}

/** 与えられた pid から最大5段階上向きに親プロセスを辿り、tmux pane に当たれば session 名を返す */
function findTmuxAncestor(startPid: number, paneMap: Map<number, string>): string | null {
  let cur = startPid;
  for (let i = 0; i < 5; i++) {
    const name = paneMap.get(cur);
    if (name) return name;
    let next = 0;
    try {
      const status = readFileSync(`/proc/${cur}/status`, 'utf-8');
      const m = status.match(/^PPid:\s+(\d+)/m);
      if (m) next = Number(m[1]);
    } catch {
      return null;
    }
    if (!next || next === 1 || next === cur) return null;
    cur = next;
  }
  return null;
}

async function getTmuxPaneMap(): Promise<Map<number, string>> {
  try {
    const { stdout } = await exec('tmux', [
      'list-panes',
      '-a',
      '-F',
      '#{pane_pid}|#{session_name}',
    ]);
    const map = new Map<number, string>();
    for (const line of stdout.split('\n')) {
      const [pidStr, name] = line.split('|');
      const pid = Number(pidStr);
      if (Number.isFinite(pid) && name) map.set(pid, name);
    }
    return map;
  } catch {
    return new Map();
  }
}
