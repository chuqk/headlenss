import { AmiVoiceBackend } from './amivoice.ts';
import { SpeechmaticsBackend } from './speechmatics.ts';
import type { AsrBackend, AsrReady, AsrResult } from './types.ts';
import { pcmToWav } from './wav.ts';
import { WhisperCppBackend } from './whisper-cpp.ts';

export type { AsrReady, AsrResult } from './types.ts';

const BACKEND_NAME = (process.env.ASR_BACKEND ?? 'whisper-cpp').toLowerCase();

function selectBackend(name: string): AsrBackend {
  switch (name) {
    case 'amivoice':
      return new AmiVoiceBackend();
    case 'speechmatics':
      return new SpeechmaticsBackend();
    case 'whisper-cpp':
    case 'whisper':
      return new WhisperCppBackend();
    default:
      throw new Error(
        `unknown ASR_BACKEND: "${name}". expected one of: whisper-cpp, amivoice, speechmatics`,
      );
  }
}

const backend = selectBackend(BACKEND_NAME);

export function getBackendName(): string {
  return backend.name;
}

export function isAsrReady(): AsrReady {
  return backend.isReady();
}

export async function transcribeWav(wav: Buffer, language?: string): Promise<AsrResult> {
  return backend.transcribeWav(wav, language);
}

export async function transcribePcm16(pcm: Buffer, language?: string): Promise<AsrResult> {
  return backend.transcribeWav(pcmToWav(pcm), language);
}
