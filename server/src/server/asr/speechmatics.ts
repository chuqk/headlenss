import type { AsrBackend, AsrReady, AsrResult } from './types.ts';

const API_BASE = 'https://asr.api.speechmatics.com/v2';

type SubmitResponse = { id: string };
type StatusResponse = { job: { id: string; status: 'running' | 'done' | 'rejected'; errors?: unknown[] } };

export class SpeechmaticsBackend implements AsrBackend {
  readonly name = 'speechmatics';

  private readonly apikey = process.env.SPEECHMATICS_API_KEY ?? '';
  private readonly operatingPoint =
    (process.env.SPEECHMATICS_OPERATING_POINT as 'standard' | 'enhanced') ?? 'enhanced';
  private readonly defaultLang = process.env.SPEECHMATICS_LANG ?? 'ja';
  private readonly maxWaitMs = Number(process.env.SPEECHMATICS_MAX_WAIT_MS ?? 60000);
  private readonly pollIntervalMs = Number(process.env.SPEECHMATICS_POLL_MS ?? 500);

  isReady(): AsrReady {
    if (!this.apikey) {
      return {
        ok: false,
        reason:
          'SPEECHMATICS_API_KEY env var is not set. sign up at https://portal.speechmatics.com/',
      };
    }
    return { ok: true };
  }

  async transcribeWav(wav: Buffer, language?: string): Promise<AsrResult> {
    const ready = this.isReady();
    if (!ready.ok) throw new Error(ready.reason);

    const lang = language && language !== 'auto' ? language : this.defaultLang;
    const config = {
      type: 'transcription',
      transcription_config: {
        language: lang,
        operating_point: this.operatingPoint,
      },
    };

    const form = new FormData();
    const audioBytes = new Uint8Array(wav.byteLength);
    audioBytes.set(wav);
    form.append('data_file', new Blob([audioBytes], { type: 'audio/wav' }), 'audio.wav');
    form.append('config', JSON.stringify(config));

    const headers = { Authorization: `Bearer ${this.apikey}` };
    const t0 = Date.now();

    const submitRes = await fetch(`${API_BASE}/jobs/`, { method: 'POST', headers, body: form });
    if (!submitRes.ok) {
      const body = await submitRes.text().catch(() => '');
      throw new Error(`speechmatics submit HTTP ${submitRes.status}: ${body.slice(0, 500)}`);
    }
    const { id: jobId } = (await submitRes.json()) as SubmitResponse;

    const start = Date.now();
    while (Date.now() - start < this.maxWaitMs) {
      await new Promise((r) => setTimeout(r, this.pollIntervalMs));
      const statusRes = await fetch(`${API_BASE}/jobs/${jobId}`, { headers });
      if (!statusRes.ok) {
        const body = await statusRes.text().catch(() => '');
        throw new Error(`speechmatics status HTTP ${statusRes.status}: ${body.slice(0, 500)}`);
      }
      const status = (await statusRes.json()) as StatusResponse;
      if (status.job.status === 'done') break;
      if (status.job.status === 'rejected') {
        throw new Error(`speechmatics job ${jobId} rejected: ${JSON.stringify(status.job.errors ?? [])}`);
      }
    }

    const transcriptRes = await fetch(`${API_BASE}/jobs/${jobId}/transcript?format=txt`, { headers });
    if (!transcriptRes.ok) {
      const body = await transcriptRes.text().catch(() => '');
      throw new Error(`speechmatics transcript HTTP ${transcriptRes.status}: ${body.slice(0, 500)}`);
    }
    const text = (await transcriptRes.text()).trim();
    const durationMs = Date.now() - t0;

    return { text, language: lang, durationMs };
  }
}
