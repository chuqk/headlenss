// Speechmatics Realtime WebSocket クライアント (ブラウザ直接接続)。
//
// 流れ:
//   1. POST https://mp.speechmatics.com/v1/api_keys?type=rt   (一時JWT発行)
//   2. wss://<region>.rt.speechmatics.com/v2?jwt=<...>        (接続)
//   3. StartRecognition JSON 送信
//   4. RecognitionStarted を受信したら start() resolve
//   5. AddAudio バイナリフレームを連投 (PCM s16le 16kHz mono、100ms チャンク推奨)
//   6. EndOfStream { last_seq_no } 送信 → EndOfTranscript 受信で確定テキストが揃う
//
// AddPartialTranscript : 中間結果 (上書きされうる、レンズの即時表示に使う)
// AddTranscript        : 確定テキスト (積み増し、最終的にこれを連結したものが結果)

import type { OperatingPoint } from './settings'

const JWT_ENDPOINT = 'https://mp.speechmatics.com/v1/api_keys?type=rt'
const JWT_TTL_SEC = 60
const STOP_TIMEOUT_MS = 8000

export type RTRegion = 'eu' | 'us'

export type SpeechmaticsRTOptions = {
  apiKey: string
  language: string
  operatingPoint: OperatingPoint
  region?: RTRegion
  maxDelay?: number     // 確定までの最大待機時間 (秒)、0.7〜4.0
  enablePartials?: boolean
  onPartial?: (text: string) => void  // 中間文字起こし (現在のpartial含む全文)
  onFinal?: (text: string) => void    // 確定文字起こし (確定分のみの全文)
  onError?: (err: Error) => void
}

type ServerMessage =
  | { message: 'RecognitionStarted'; id?: string }
  | { message: 'AudioAdded'; seq_no: number }
  | { message: 'AddPartialTranscript'; metadata: { transcript: string } }
  | { message: 'AddTranscript'; metadata: { transcript: string } }
  | { message: 'EndOfTranscript' }
  | { message: 'Info'; type?: string; reason?: string }
  | { message: 'Warning'; type?: string; reason?: string }
  | { message: 'Error'; type?: string; reason?: string }

async function fetchJwt(apiKey: string): Promise<string> {
  const res = await fetch(JWT_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ttl: JWT_TTL_SEC }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`JWT fetch HTTP ${res.status}: ${body.slice(0, 300)}`)
  }
  const data = (await res.json()) as { key_value?: string }
  if (!data.key_value) throw new Error('JWT response missing key_value')
  return data.key_value
}

export class SpeechmaticsRT {
  private ws: WebSocket | null = null
  private seqNo = 0
  private finals: string[] = []
  private currentPartial = ''
  private endWaiter: { resolve: (text: string) => void; reject: (err: Error) => void } | null = null
  private opts: SpeechmaticsRTOptions | null = null
  private startedAt = 0

  async start(opts: SpeechmaticsRTOptions): Promise<void> {
    if (!opts.apiKey) throw new Error('Speechmatics API key is empty')
    this.opts = opts
    this.startedAt = performance.now()

    const jwt = await fetchJwt(opts.apiKey)
    const region: RTRegion = opts.region ?? 'eu'
    const url = `wss://${region}.rt.speechmatics.com/v2?jwt=${encodeURIComponent(jwt)}`

    return new Promise<void>((resolve, reject) => {
      let opened = false
      const ws = new WebSocket(url)
      ws.binaryType = 'arraybuffer'
      this.ws = ws

      const failOpen = (msg: string) => {
        if (opened) return
        opened = true
        try { ws.close() } catch { /* ignore */ }
        reject(new Error(msg))
      }

      ws.onopen = () => {
        const config = {
          message: 'StartRecognition',
          audio_format: {
            type: 'raw',
            encoding: 'pcm_s16le',
            sample_rate: 16000,
          },
          transcription_config: {
            language: opts.language,
            operating_point: opts.operatingPoint,
            max_delay: opts.maxDelay ?? 1.0,
            max_delay_mode: 'flexible',
            enable_partials: opts.enablePartials ?? true,
          },
        }
        try {
          ws.send(JSON.stringify(config))
        } catch (err) {
          failOpen(`StartRecognition send error: ${(err as Error).message}`)
        }
      }

      ws.onmessage = (ev) => {
        if (typeof ev.data !== 'string') return
        let msg: ServerMessage
        try {
          msg = JSON.parse(ev.data) as ServerMessage
        } catch {
          return
        }
        this.handleServerMessage(msg, () => {
          if (!opened) {
            opened = true
            resolve()
          }
        })
      }

      ws.onerror = () => failOpen('WebSocket error')

      ws.onclose = (e) => {
        if (!opened) {
          failOpen(`WebSocket closed before start (${e.code} ${e.reason || ''})`)
          return
        }
        if (this.endWaiter) {
          this.endWaiter.resolve(this.fullTranscript())
          this.endWaiter = null
        }
      }
    })
  }

  private handleServerMessage(msg: ServerMessage, onStarted: () => void): void {
    switch (msg.message) {
      case 'RecognitionStarted':
        onStarted()
        break
      case 'AddPartialTranscript':
        this.currentPartial = msg.metadata?.transcript ?? ''
        this.opts?.onPartial?.(this.fullTranscript())
        break
      case 'AddTranscript': {
        const text = msg.metadata?.transcript ?? ''
        if (text) this.finals.push(text)
        this.currentPartial = ''
        this.opts?.onFinal?.(this.finals.join(''))
        break
      }
      case 'EndOfTranscript':
        if (this.endWaiter) {
          this.endWaiter.resolve(this.finals.join(''))
          this.endWaiter = null
        }
        try { this.ws?.close(1000) } catch { /* ignore */ }
        break
      case 'Error': {
        const reason = `${msg.type ?? ''}${msg.reason ? `: ${msg.reason}` : ''}`
        const err = new Error(`Speechmatics RT Error ${reason}`)
        this.opts?.onError?.(err)
        if (this.endWaiter) {
          this.endWaiter.reject(err)
          this.endWaiter = null
        }
        try { this.ws?.close() } catch { /* ignore */ }
        break
      }
      case 'Warning':
      case 'Info':
        // 必要なら opts.onError 等にフックするが、現状は黙って捨てる
        break
      default:
        break
    }
  }

  /** PCM (s16le 16kHz mono) のバイナリチャンクを送る。100ms 単位推奨 */
  send(pcm: Uint8Array): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    // ArrayBufferを別領域にコピーしてSAB混入を避ける
    const out = new ArrayBuffer(pcm.byteLength)
    new Uint8Array(out).set(pcm)
    this.ws.send(out)
    this.seqNo += 1
  }

  /** EndOfStream を送り、EndOfTranscript を待って確定テキストを返す */
  async stop(): Promise<string> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return this.finals.join('')
    }
    return new Promise<string>((resolve, reject) => {
      this.endWaiter = {
        resolve: (text) => resolve(text.trim()),
        reject,
      }
      try {
        this.ws!.send(JSON.stringify({ message: 'EndOfStream', last_seq_no: this.seqNo }))
      } catch (err) {
        reject(err as Error)
        return
      }
      // 万一サーバから EndOfTranscript が来ない場合の保険
      setTimeout(() => {
        if (this.endWaiter) {
          this.endWaiter.resolve(this.fullTranscript())
          this.endWaiter = null
          try { this.ws?.close() } catch { /* ignore */ }
        }
      }, STOP_TIMEOUT_MS)
    })
  }

  /** 強制切断 (エラー時など) */
  abort(): void {
    if (this.endWaiter) {
      this.endWaiter.reject(new Error('aborted'))
      this.endWaiter = null
    }
    try { this.ws?.close() } catch { /* ignore */ }
    this.ws = null
  }

  /** 現在の (partial 含む) 全文 */
  fullTranscript(): string {
    return (this.finals.join('') + this.currentPartial).trim()
  }

  elapsedMs(): number {
    return performance.now() - this.startedAt
  }
}
