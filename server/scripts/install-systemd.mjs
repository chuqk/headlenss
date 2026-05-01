#!/usr/bin/env node
// Install a systemd --user service for the headlenss server.
// Idempotent — safe to re-run.
import { execSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = resolve(__dirname, '..');
const TEMPLATE_PATH = resolve(__dirname, 'headlenss.service.template');
const USER_SYSTEMD_DIR = resolve(homedir(), '.config/systemd/user');
const UNIT_PATH = resolve(USER_SYSTEMD_DIR, 'headlenss.service');

function step(msg) {
  console.log(`\n==> ${msg}`);
}

function which(cmd) {
  const r = spawnSync('which', [cmd], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

function run(cmd, args, opts = {}) {
  console.log(`  $ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.status !== 0) {
    throw new Error(`failed: ${cmd} ${args.join(' ')} (exit ${r.status})`);
  }
}

if (process.platform !== 'linux') {
  console.error('this installer targets Linux + systemd only.');
  console.error('on macOS, you can either:');
  console.error('  - run inside tmux:  tmux new-session -d -s headlenss-server "cd ' + SERVER_DIR + ' && npm start"');
  console.error('  - write a launchd plist (~/Library/LaunchAgents/) — out of scope here');
  process.exit(1);
}

step('checking systemd --user availability');
const systemctl = which('systemctl');
if (!systemctl) {
  console.error('  systemctl not found. is this a systemd-based system?');
  process.exit(1);
}
try {
  execSync('systemctl --user show-environment >/dev/null 2>&1');
  console.log('  systemd --user is reachable');
} catch {
  console.error('  systemd --user is not reachable. ensure your session has DBUS_SESSION_BUS_ADDRESS / XDG_RUNTIME_DIR set,');
  console.error('  or that you are using a systemd-managed login. you can also try:');
  console.error('    loginctl enable-linger $USER  (requires sudo)');
  console.error('  and re-run from a fresh shell.');
  process.exit(1);
}

step('locating npm');
const npmPath = which('npm') ?? 'npm';
console.log(`  npm: ${npmPath}`);

step('rendering unit file');
const template = readFileSync(TEMPLATE_PATH, 'utf8');
const unit = template
  .replaceAll('{{SERVER_DIR}}', SERVER_DIR)
  .replaceAll('{{NPM}}', npmPath)
  .replaceAll('{{PATH}}', process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin');

mkdirSync(USER_SYSTEMD_DIR, { recursive: true });
writeFileSync(UNIT_PATH, unit);
console.log(`  wrote: ${UNIT_PATH}`);

step('reloading systemd and enabling unit');
run(systemctl, ['--user', 'daemon-reload']);
run(systemctl, ['--user', 'enable', 'headlenss.service']);

step('starting service');
try {
  run(systemctl, ['--user', 'restart', 'headlenss.service']);
} catch {
  console.error('\nstart failed. check logs:');
  console.error('  journalctl --user -u headlenss -n 50 --no-pager');
  process.exit(1);
}

step('done');
console.log('  service installed, enabled, and started.');
console.log('\nuseful commands:');
console.log('  npm run service:status     # systemctl --user status headlenss');
console.log('  npm run service:logs       # journalctl --user -u headlenss -f');
console.log('  systemctl --user restart headlenss');
console.log('  systemctl --user stop headlenss');
console.log('  systemctl --user disable headlenss');

const lingerPath = `/var/lib/systemd/linger/${process.env.USER ?? ''}`;
if (process.env.USER && !existsSync(lingerPath)) {
  console.log('\nNOTE: to keep the service running after you log out / on reboot,');
  console.log('enable user-linger ONCE (requires sudo):');
  console.log(`  sudo loginctl enable-linger ${process.env.USER}`);
} else if (existsSync(lingerPath)) {
  console.log('\nlinger already enabled — service will survive logout & reboot.');
}
