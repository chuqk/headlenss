import type { AsrBackend, AsrReady, AsrResult } from './types.ts';

const ENDPOINTS = {
  log: 'https://acp-api.amivoice.com/v1/recognize',
  nolog: 'https://acp-api.amivoice.com/v1/nolog/recognize',
};

type AmiVoiceResponse = {
  text?: string;
  results?: { text: string }[];
  utteranceid?: string;
  code?: string;
  message?: string;
};

export class AmiVoiceBackend implements AsrBackend {
  readonly name = 'amivoice';

  private readonly appkey = process.env.AMIVOICE_APPKEY ?? '';
  private readonly engine = process.env.AMIVOICE_ENGINE ?? '-a-general-input';
  private readonly allowLogging =
    process.env.AMIVOICE_ALLOW_LOGGING === 'true' || process.env.AMIVOICE_ALLOW_LOGGING === '1';

  isReady(): AsrReady {
    if (!this.appkey) {
      return {
        ok: false,
        reason:
          'AMIVOICE_APPKEY env var is not set. sign up at https://acp.amivoice.com/ and set the APPKEY.',
      };
    }
    return { ok: true };
  }

  async transcribeWav(wav: Buffer, language?: string): Promise<AsrResult> {
    const ready = this.isReady();
    if (!ready.ok) throw new Error(ready.reason);

    const url = this.allowLogging ? ENDPOINTS.log : ENDPOINTS.nolog;
    const form = new FormData();
    form.append('u', this.appkey);
    form.append('d', `grammarFileNames=${this.engine}`);
    const audioBytes = new Uint8Array(wav.byteLength);
    audioBytes.set(wav);
    form.append('a', new Blob([audioBytes], { type: 'audio/wav' }), 'audio.wav');

    const t0 = Date.now();
    const res = await fetch(url, { method: 'POST', body: form });
    const durationMs = Date.now() - t0;

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`amivoice HTTP ${res.status}: ${body.slice(0, 500)}`);
    }

    const json = (await res.json()) as AmiVoiceResponse;
    if (json.code && json.code !== '') {
      throw new Error(`amivoice error code "${json.code}": ${json.message ?? ''}`);
    }

    return {
      text: (json.text ?? '').trim(),
      language: language ?? 'ja',
      durationMs,
    };
  }
}
