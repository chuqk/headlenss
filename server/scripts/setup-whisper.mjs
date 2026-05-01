#!/usr/bin/env node
// One-time setup: clone whisper.cpp, build it, download the model.
// Idempotent — safe to re-run.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync, createWriteStream } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = resolve(__dirname, '..');
const VENDOR_DIR = resolve(SERVER_ROOT, 'vendor');
const WHISPER_DIR = resolve(VENDOR_DIR, 'whisper.cpp');
const BUILD_DIR = resolve(WHISPER_DIR, 'build');
const BIN_PATH = resolve(BUILD_DIR, 'bin', 'whisper-cli');
const MODELS_DIR = resolve(SERVER_ROOT, 'models');

const WHISPER_CPP_REPO = 'https://github.com/ggml-org/whisper.cpp.git';
const WHISPER_CPP_REF = process.env.WHISPER_CPP_REF || 'master';
const MODEL_NAME = process.env.WHISPER_MODEL || 'ggml-large-v3-turbo-q5_0.bin';
const MODEL_URL = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${MODEL_NAME}`;

function step(name) {
  console.log(`\n==> ${name}`);
}

function checkCmd(cmd) {
  const r = spawnSync(cmd, ['--version'], { stdio: 'ignore' });
  return r.status === 0;
}

function run(cmd, args, opts = {}) {
  console.log(`  $ ${cmd} ${args.join(' ')}${opts.cwd ? `  (in ${opts.cwd})` : ''}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.status !== 0) {
    console.error(`\nfailed: ${cmd} ${args.join(' ')}`);
    process.exit(r.status ?? 1);
  }
}

async function downloadFile(url, dest) {
  console.log(`  fetching ${url}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const total = Number(res.headers.get('content-length') ?? 0);
  let downloaded = 0;
  const file = createWriteStream(dest);
  const reader = res.body.getReader();
  let lastTick = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    file.write(value);
    downloaded += value.length;
    const now = Date.now();
    if (now - lastTick > 200) {
      lastTick = now;
      const mb = (downloaded / 1e6).toFixed(1);
      const totalMb = (total / 1e6).toFixed(1);
      const pct = total > 0 ? `${((downloaded / total) * 100).toFixed(1)}%` : '';
      process.stdout.write(`\r  ${pct} ${mb}MB / ${totalMb}MB`);
    }
  }
  await new Promise((r) => file.end(r));
  process.stdout.write('\n');
}

async function main() {
  step('checking build tools');
  const required = ['cmake', 'make', 'git', 'curl'];
  const missing = required.filter((c) => !checkCmd(c));
  if (missing.length > 0) {
    console.error(`\n  missing: ${missing.join(', ')}`);
    console.error('\nplease install build tools first:');
    console.error('  Ubuntu/Debian: sudo apt install -y build-essential cmake git curl');
    console.error('  Fedora:        sudo dnf install -y gcc-c++ cmake git curl make');
    console.error('  macOS:         xcode-select --install && brew install cmake');
    process.exit(1);
  }
  console.log('  all required tools found');

  mkdirSync(VENDOR_DIR, { recursive: true });
  mkdirSync(MODELS_DIR, { recursive: true });

  step(`fetching whisper.cpp (ref: ${WHISPER_CPP_REF})`);
  if (existsSync(WHISPER_DIR)) {
    console.log('  whisper.cpp already cloned (skipping clone)');
  } else {
    run('git', ['clone', '--depth', '1', '--branch', WHISPER_CPP_REF, WHISPER_CPP_REPO, WHISPER_DIR]);
  }

  step('building whisper.cpp');
  if (existsSync(BIN_PATH)) {
    console.log(`  whisper-cli already built (skipping): ${BIN_PATH}`);
  } else {
    run('cmake', ['-B', 'build', '-DCMAKE_BUILD_TYPE=Release'], { cwd: WHISPER_DIR });
    run('cmake', ['--build', 'build', '-j', '--config', 'Release'], { cwd: WHISPER_DIR });
    if (!existsSync(BIN_PATH)) {
      console.error(`build finished but binary not found at: ${BIN_PATH}`);
      process.exit(1);
    }
  }

  step(`downloading model: ${MODEL_NAME}`);
  const modelPath = resolve(MODELS_DIR, MODEL_NAME);
  if (existsSync(modelPath) && statSync(modelPath).size > 100_000_000) {
    console.log(`  model already downloaded (skipping): ${modelPath}`);
  } else {
    await downloadFile(MODEL_URL, modelPath);
  }

  step('smoke test');
  const sample = resolve(WHISPER_DIR, 'samples', 'jfk.wav');
  if (existsSync(sample)) {
    run(BIN_PATH, ['-m', modelPath, '-f', sample, '-l', 'en', '--no-prints', '-nt']);
  } else {
    console.log('  jfk.wav sample not found, skipping smoke test');
  }

  console.log('\nsetup complete!');
  console.log(`  whisper-cli: ${BIN_PATH}`);
  console.log(`  model:       ${modelPath}`);
  console.log('\nnext: npm run build && npm start');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
