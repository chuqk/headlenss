// headlenssサーバ (server/) とのHTTPクライアント。
// Speechmaticsから受け取ったテキストを tmux session に流し込むのが主目的。

import { trimTrailingSlash } from './settings'

export type Session = {
  name: string
  created: number
  windows: number
  attached: boolean
}

export type SendKeysOptions = {
  text: string
  submit: boolean
}

export class HeadlenssClient {
  constructor(private base: string) {}

  setBase(base: string): void {
    this.base = base
  }

  private url(path: string): string {
    return `${trimTrailingSlash(this.base)}${path}`
  }

  async health(): Promise<{ ok: boolean }> {
    const res = await fetch(this.url('/api/health'))
    if (!res.ok) throw new Error(`health HTTP ${res.status}`)
    return (await res.json()) as { ok: boolean }
  }

  async listSessions(): Promise<Session[]> {
    const res = await fetch(this.url('/api/sessions'))
    if (!res.ok) throw new Error(`listSessions HTTP ${res.status}`)
    const data = (await res.json()) as { sessions: Session[] }
    return data.sessions
  }

  async sendKeys(name: string, opts: SendKeysOptions): Promise<void> {
    const res = await fetch(this.url(`/api/sessions/${encodeURIComponent(name)}/input`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: opts.text, submit: opts.submit }),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`sendKeys HTTP ${res.status}: ${body.slice(0, 200)}`)
    }
  }

  async createSession(name: string): Promise<void> {
    const res = await fetch(this.url('/api/sessions'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`createSession HTTP ${res.status}: ${body.slice(0, 200)}`)
    }
  }

  async killSession(name: string): Promise<void> {
    const res = await fetch(this.url(`/api/sessions/${encodeURIComponent(name)}`), {
      method: 'DELETE',
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`killSession HTTP ${res.status}: ${body.slice(0, 200)}`)
    }
  }

  async getOutput(name: string, lines = 24): Promise<string> {
    const res = await fetch(
      this.url(`/api/sessions/${encodeURIComponent(name)}/output?lines=${lines}`),
    )
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`getOutput HTTP ${res.status}: ${body.slice(0, 200)}`)
    }
    const data = (await res.json()) as { text: string }
    return data.text
  }
}
