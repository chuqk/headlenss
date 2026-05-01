import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { availableParallelism, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AsrBackend, AsrReady, AsrResult } from './types.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = resolve(__dirname, '../../..');

type WhisperJson = {
  result?: { language?: string };
  transcription?: { text: string }[];
};

export class WhisperCppBackend implements AsrBackend {
  readonly name = 'whisper-cpp';

  private readonly bin =
    process.env.WHISPER_BIN ?? resolve(SERVER_ROOT, 'vendor/whisper.cpp/build/bin/whisper-cli');
  private readonly modelName = process.env.WHISPER_MODEL ?? 'ggml-large-v3-turbo-q5_0.bin';
  private readonly modelPath =
    process.env.WHISPER_MODEL_PATH ?? resolve(SERVER_ROOT, 'models', this.modelName);
  private readonly defaultLang = process.env.WHISPER_LANG ?? 'auto';
  private readonly threads =
    process.env.WHISPER_THREADS ?? String(Math.max(2, availableParallelism()));

  isReady(): AsrReady {
    if (!existsSync(this.bin)) {
      return { ok: false, reason: `whisper-cli not found at ${this.bin}. run: npm run setup` };
    }
    if (!existsSync(this.modelPath)) {
      return { ok: false, reason: `model not found at ${this.modelPath}. run: npm run setup` };
    }
    return { ok: true };
  }

  async transcribeWav(wav: Buffer, language?: string): Promise<AsrResult> {
    const ready = this.isReady();
    if (!ready.ok) throw new Error(ready.reason);

    const dir = await mkdtemp(join(tmpdir(), 'headlenss-asr-'));
    const wavPath = join(dir, 'in.wav');
    const outPrefix = join(dir, 'out');
    const jsonPath = `${outPrefix}.json`;

    try {
      await writeFile(wavPath, wav);

      const lang = language ?? this.defaultLang;
      const args = [
        '-m', this.modelPath,
        '-f', wavPath,
        '-l', lang,
        '-t', this.threads,
        '-oj',
        '-of', outPrefix,
        '--no-prints',
        '-nt',
      ];

      const t0 = Date.now();
      await this.execBin(args);
      const durationMs = Date.now() - t0;

      const raw = await readFile(jsonPath, 'utf-8');
      const json = JSON.parse(raw) as WhisperJson;
      const text = (json.transcription ?? []).map((s) => s.text).join('').trim();
      return { text, language: json.result?.language, durationMs };
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  private execBin(args: string[]): Promise<void> {
    return new Promise((res, rej) => {
      const p = spawn(this.bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      p.stderr.on('data', (d) => (stderr += d.toString()));
      p.on('error', rej);
      p.on('close', (code) => {
        if (code === 0) res();
        else rej(new Error(`whisper-cli exited with code ${code}: ${stderr.trim()}`));
      });
    });
  }
}
