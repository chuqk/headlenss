// G2 SDK 経由の audioEvent.audioPcm (16kHz / S16LE / mono) を受け取って
// 録音時間 (バイト数) の集計だけ行うシンプルなトラッカ。
// リアルタイム接続では Speechmatics へ直接 PCM チャンクを流し続けるので、
// 過去フレームをまとめてバッファする必要は無い。

const SAMPLE_RATE = 16000
const BITS_PER_SAMPLE = 16
const CHANNELS = 1

let totalBytes = 0

export function trackPcmFrame(pcm: Uint8Array): void {
  totalBytes += pcm.byteLength
}

export function resetPcmCounter(): void {
  totalBytes = 0
}

export function getRecordingSeconds(): number {
  return totalBytes / (SAMPLE_RATE * (BITS_PER_SAMPLE / 8) * CHANNELS)
}

export function getPcmByteLength(): number {
  return totalBytes
}

export const AUDIO_FORMAT = {
  sampleRate: SAMPLE_RATE,
  bitsPerSample: BITS_PER_SAMPLE,
  channels: CHANNELS,
}
