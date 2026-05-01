export type AsrResult = {
  text: string;
  language?: string;
  durationMs: number;
};

export type AsrReady = { ok: true } | { ok: false; reason: string };

export interface AsrBackend {
  name: string;
  isReady(): AsrReady;
  transcribeWav(wav: Buffer, language?: string): Promise<AsrResult>;
}
