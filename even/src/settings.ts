import type { EvenAppBridge } from '@evenrealities/even_hub_sdk'
import type { Language } from './i18n'

// 設定の永続化。bridge.setLocalStorage と localStorage の両方に書き込み、
// G2アプリ環境とブラウザ単体テストの両方で同じ値が読めるようにする。

const STORAGE_KEY = 'headlenss_settings_v1'

export type OperatingPoint = 'standard' | 'enhanced'

export type Settings = {
  serverBaseUrl: string
  sessionName: string
  submitOnSend: boolean
  speechmaticsApiKey: string
  speechmaticsLang: string
  speechmaticsOperatingPoint: OperatingPoint
  language: Language
}

export const DEFAULT_SETTINGS: Settings = {
  serverBaseUrl: '',
  sessionName: 'master',
  submitOnSend: true,
  speechmaticsApiKey: '',
  speechmaticsLang: 'ja',
  speechmaticsOperatingPoint: 'enhanced',
  language: 'ja',
}

function parse(json: string | null | undefined): Settings | null {
  if (!json) return null
  try {
    const raw = JSON.parse(json) as Partial<Settings>
    if (typeof raw !== 'object' || raw === null) return null
    return {
      serverBaseUrl: typeof raw.serverBaseUrl === 'string' ? raw.serverBaseUrl : DEFAULT_SETTINGS.serverBaseUrl,
      sessionName: typeof raw.sessionName === 'string' && raw.sessionName ? raw.sessionName : DEFAULT_SETTINGS.sessionName,
      submitOnSend: typeof raw.submitOnSend === 'boolean' ? raw.submitOnSend : DEFAULT_SETTINGS.submitOnSend,
      speechmaticsApiKey: typeof raw.speechmaticsApiKey === 'string' ? raw.speechmaticsApiKey : '',
      speechmaticsLang: typeof raw.speechmaticsLang === 'string' && raw.speechmaticsLang ? raw.speechmaticsLang : DEFAULT_SETTINGS.speechmaticsLang,
      speechmaticsOperatingPoint:
        raw.speechmaticsOperatingPoint === 'standard' || raw.speechmaticsOperatingPoint === 'enhanced'
          ? raw.speechmaticsOperatingPoint
          : DEFAULT_SETTINGS.speechmaticsOperatingPoint,
      language: raw.language === 'en' || raw.language === 'ja' ? raw.language : DEFAULT_SETTINGS.language,
    }
  } catch {
    return null
  }
}

export async function loadSettings(bridge: EvenAppBridge | null): Promise<Settings> {
  if (bridge) {
    try {
      const v = await bridge.getLocalStorage(STORAGE_KEY)
      const parsed = parse(v)
      if (parsed) return parsed
    } catch {
      // bridge側に値が無いだけのこともある。下に落とす
    }
  }
  return parse(localStorage.getItem(STORAGE_KEY)) ?? { ...DEFAULT_SETTINGS }
}

export async function saveSettings(bridge: EvenAppBridge | null, s: Settings): Promise<void> {
  const json = JSON.stringify(s)
  try { localStorage.setItem(STORAGE_KEY, json) } catch { /* quota */ }
  if (bridge) {
    try { await bridge.setLocalStorage(STORAGE_KEY, json) } catch { /* ignore */ }
  }
}

export function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '')
}
