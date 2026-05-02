import { waitForEvenAppBridge } from '@evenrealities/even_hub_sdk'
import type { EvenAppBridge } from '@evenrealities/even_hub_sdk'

import {
  getPcmByteLength,
  getRecordingSeconds,
  resetPcmCounter,
  trackPcmFrame,
} from './audio'
import { onEvenHubEvent, setEventHandlers } from './events'
import { initRenderer, resetPageState, showScreen, updateContent, updateFooter } from './renderer'
import {
  HeadlenssClient,
  type ChatItem,
  type ClaudeSessionInfo,
  type Pending,
  type Session,
} from './server-client'
import {
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  type OperatingPoint,
  type Settings,
} from './settings'
import { SpeechmaticsRT } from './speechmatics-rt'

// ───────────────────────────────────────────────────────────────────────
// 利用シーン: G2 をかけてポケットのスマホ (このWebView) で動かす。
// G2クリック → 喋ってる最中から partial がレンズに出る → もう一度クリックで確定 →
// 確定テキストが tmux に流れる。
// ───────────────────────────────────────────────────────────────────────

const BRIDGE_TIMEOUT_MS = 4000
const MAX_RECORDING_SEC = 28 // G2の連続録音は30秒制限の手前で安全停止
const MIN_RECORDING_SEC = 0.2
const HISTORY_LIMIT = 20
const PROBE_DEBOUNCE_MS = 500
const SESSIONS_REFRESH_MS = 15000
const G2_REFRESH_THROTTLE_MS = 250

// ─── DOM ───────────────────────────────────────────────────────────────
const bodyEl = document.body

// Onboarding
const obSteps = Array.from(document.querySelectorAll<HTMLDivElement>('.ob-step'))
const obServerUrlEl = document.getElementById('ob-server-url') as HTMLInputElement
const obServerProbeEl = document.getElementById('ob-server-probe') as HTMLDivElement
const obNext1Btn = document.getElementById('ob-next-1') as HTMLButtonElement
const obSmKeyEl = document.getElementById('ob-sm-key') as HTMLInputElement
const obBackBtn = document.getElementById('ob-back') as HTMLButtonElement
const obFinishBtn = document.getElementById('ob-finish') as HTMLButtonElement

// Dashboard
const statusDotEl = document.getElementById('statusDot') as HTMLSpanElement
const statusTextEl = document.getElementById('statusText') as HTMLSpanElement
const activeSessionNameEl = document.getElementById('activeSessionName') as HTMLElement

const sessionPillsEl = document.getElementById('sessionPills') as HTMLDivElement
const reloadSessionsBtn = document.getElementById('reloadSessionsBtn') as HTMLButtonElement
const newSessionForm = document.getElementById('newSessionForm') as HTMLFormElement
const newSessionInput = document.getElementById('newSessionInput') as HTMLInputElement

const historyListEl = document.getElementById('historyList') as HTMLOListElement
const clearHistoryBtn = document.getElementById('clearHistoryBtn') as HTMLButtonElement

const settingsDetails = document.getElementById('settingsDetails') as HTMLDetailsElement
const serverUrlEl = document.getElementById('serverUrl') as HTMLInputElement
const serverProbeText = document.getElementById('serverProbeText') as HTMLSpanElement
const submitOnSendEl = document.getElementById('submitOnSend') as HTMLInputElement
const smApiKeyEl = document.getElementById('smApiKey') as HTMLInputElement
const smLangEl = document.getElementById('smLang') as HTMLInputElement
const smOperatingPointEl = document.getElementById('smOperatingPoint') as HTMLSelectElement
const resetOnboardingBtn = document.getElementById('resetOnboardingBtn') as HTMLButtonElement

const pendingSection = document.getElementById('pendingSection') as HTMLElement
const pendingTextEl = document.getElementById('pendingText') as HTMLDivElement
const confirmBtn = document.getElementById('confirmBtn') as HTMLButtonElement
const discardBtn = document.getElementById('discardBtn') as HTMLButtonElement

const tmuxOutputEl = document.getElementById('tmuxOutput') as HTMLPreElement
const reloadOutputBtn = document.getElementById('reloadOutputBtn') as HTMLButtonElement

const recordBtn = document.getElementById('recordBtn') as HTMLButtonElement
const durationEl = document.getElementById('duration') as HTMLSpanElement

const logEl = document.getElementById('log') as HTMLPreElement

// ─── State ─────────────────────────────────────────────────────────────
// 画面遷移:
//   boot → (設定済) → rootlist ──click──> idle (selected session)
//                                     ↑doubleClick (戻る)
//   idle ──click──> recording ──click──> pending ──↑scroll──> sending ──> idle
//                                              └──↓scroll──> idle (破棄)
type Phase =
  | 'boot' | 'unconfigured' | 'rootlist' | 'idle'
  | 'recording' | 'finalizing' | 'pending' | 'sending'
  | 'cc-response'  // Claude Code の承認/質問待ちに応答する画面
  | 'error'

const TMUX_OUTPUT_LINES = 200          // (legacy) capture-pane 用 — 現状未使用
const CHAT_DISPLAY_LINES = 8           // G2レンズに出す chat 行数 (288pxに収まる量)
const CHAT_WRAP_WIDTH = 44             // チャット行を word-wrap する幅 (even-toolkit 流)
const CC_POLL_INTERVAL_MS = 1500       // Claude sessions / chat / pending のポーリング間隔
const ROOT_LIST_VISIBLE = 8            // G2 root 画面に同時表示するセッション数

type HistoryEntry = {
  id: number
  text: string
  session: string
  ok: boolean
  durationMs: number
  errorMsg?: string
  timestamp: number
}

let bridge: EvenAppBridge | null = null
let settings: Settings = { ...DEFAULT_SETTINGS }
let phase: Phase = 'boot'
let serverProbeOk = false
let serverErrorMsg = ''
let lastSessions: Session[] = []
let history: HistoryEntry[] = []
let historyCounter = 0
let recordingTimer: ReturnType<typeof setInterval> | null = null
let sessionsRefreshTimer: ReturnType<typeof setInterval> | null = null
let probeDebounceTimer: ReturnType<typeof setTimeout> | null = null
let rtSession: SpeechmaticsRT | null = null
let liveTranscript = '' // 録音中のpartial+final結合表示用
let pendingText = ''    // 確定待ちのテキスト (送信 or 破棄選択前)
let tmuxOutput = ''     // (legacy) tmux 出力 — 現状ダッシュボードとレンズには使わない
let outputPollTimer: ReturnType<typeof setInterval> | null = null
let outputFetchOkLogged = false
let scrollOffset = 0  // chat の末尾から何行戻ったか (0=ライブ末尾)
let rootCursor = 0    // rootlist 内のカーソル位置 (claudeSessions[index])

// Claude Code hook 連携
let claudeSessions: ClaudeSessionInfo[] = []     // 起動中Claude Codeを持つtmuxセッション一覧
let claudeChat: ChatItem[] = []                  // 現在選択中セッションのチャット履歴
let claudePending: Pending | null = null         // 現在選択中セッションの承認/質問待ち
let claudePollTimer: ReturnType<typeof setInterval> | null = null
let respondCursor = 0                            // cc-response 画面のカーソル位置
let g2RefreshLastAt = 0
const client = new HeadlenssClient('')

// ─── Logging ───────────────────────────────────────────────────────────
function log(msg: string): void {
  const time = new Date().toLocaleTimeString()
  logEl.textContent = `[${time}] ${msg}\n` + (logEl.textContent ?? '')
  console.log(`[headlenss] ${msg}`)
}

// ─── Status (top bar + G2) ─────────────────────────────────────────────
function statusForCurrentPhase(): { dot: string; text: string } {
  switch (phase) {
    case 'boot':
      return { dot: 'idle', text: 'Booting…' }
    case 'rootlist':
      return { dot: 'ready', text: `Claude sessions (${claudeSessions.length})` }
    case 'cc-response':
      return { dot: 'busy', text: 'Claude 応答待ち' }
    case 'recording':
      return { dot: 'rec', text: `Recording ${getRecordingSeconds().toFixed(1)}s` }
    case 'finalizing':
      return { dot: 'busy', text: 'Finalizing…' }
    case 'pending':
      return { dot: 'busy', text: '↑ 送信 / ↓ 破棄' }
    case 'sending':
      return { dot: 'busy', text: `Sending → ${settings.sessionName || '—'}` }
    case 'error':
      return { dot: 'err', text: serverErrorMsg || 'Error' }
    case 'unconfigured':
      if (!bridge) return { dot: 'err', text: 'G2 bridge not connected' }
      if (!settings.serverBaseUrl) return { dot: 'idle', text: 'Set Server URL' }
      if (!settings.speechmaticsApiKey) return { dot: 'idle', text: 'Set Speechmatics key' }
      if (!serverProbeOk) return { dot: 'err', text: serverErrorMsg || 'Server unreachable' }
      return { dot: 'idle', text: 'Configure session' }
    case 'idle':
    default:
      return { dot: 'ready', text: `[${settings.sessionName || '?'}] Ready` }
  }
}

function paintStatus(): void {
  const s = statusForCurrentPhase()
  statusTextEl.textContent = s.text
  statusDotEl.className = `dot dot-${s.dot}`
  activeSessionNameEl.textContent = settings.sessionName || '—'
}

function isReady(): boolean {
  return Boolean(
    bridge &&
    settings.serverBaseUrl &&
    settings.speechmaticsApiKey &&
    serverProbeOk,
  )
}

function recomputePhase(): void {
  // pendingは「ユーザの判断待ち」なので自動で抜けない
  if (
    phase === 'recording' ||
    phase === 'finalizing' ||
    phase === 'pending' ||
    phase === 'sending'
  ) return
  if (!isReady()) {
    phase = 'unconfigured'
  } else if (phase !== 'rootlist' && phase !== 'idle') {
    // boot or unconfigured から ready になった: rootlist へ
    phase = 'rootlist'
    syncRootCursor()
  }
  paintStatus()
  void refreshG2()
  updateRecordButton()
  updatePendingUI()
}

/** lastSessions に対して rootCursor が指す要素を、現在の選択 (settings.sessionName) に合わせる */
function syncRootCursor(): void {
  if (claudeSessions.length === 0) {
    rootCursor = 0
    return
  }
  const idx = claudeSessions.findIndex((s) => s.tmuxSessionName === settings.sessionName)
  rootCursor = idx >= 0 ? idx : 0
}

/** Claude Code セッションの待機状態を1文字記号にする */
function claudeStatusMark(s: ClaudeSessionInfo): string {
  switch (s.status) {
    case 'waiting-permission': return '⏸'
    case 'waiting-question': return '?'
    case 'busy': return '●'
    case 'idle':
    default: return ' '
  }
}

function updatePendingUI(): void {
  if (phase === 'pending') {
    pendingSection.hidden = false
    pendingTextEl.textContent = pendingText || '(empty)'
  } else {
    pendingSection.hidden = true
  }
}

// ─── G2 lens ───────────────────────────────────────────────────────────
function buildG2Content(): string {
  // ルート画面: tmux一覧 (cursor 中央)
  if (phase === 'rootlist') {
    return buildRootListView()
  }

  // idle時は Claude Code の chat (user発言とClaude返事) を画面いっぱい使って表示。
  if (phase === 'idle') {
    const formatted = formatChatLines(claudeChat, CHAT_WRAP_WIDTH)
    if (formatted.length > 0) {
      // pending があるなら 1 行目に notice
      const notice = claudePending
        ? (claudePending.kind === 'question' ? '? 質問待ち (clickで回答)' : '⏸ 承認待ち (clickで応答)')
        : null
      const window = chatWindow(formatted, CHAT_DISPLAY_LINES - (notice ? 1 : 0))
      return notice ? [notice, ...window].join('\n') : window.join('\n')
    }
    return `[${settings.sessionName || 'no session'}]\n(まだ発言なし)`
  }

  // Claude Code 承認/質問 待ちへの応答画面
  if (phase === 'cc-response') {
    return buildCcResponseView()
  }

  // それ以外の状態は状態 + 内容を表示
  const lines: string[] = []
  if (phase === 'recording') {
    lines.push(`Recording ${getRecordingSeconds().toFixed(1)}s`)
    lines.push('')
    lines.push('▌ ' + (liveTranscript || '...'))
  } else if (phase === 'finalizing') {
    lines.push('Finalizing…')
    lines.push('▌ ' + (liveTranscript || '(processing)'))
  } else if (phase === 'pending') {
    lines.push('Confirm: ↑Send  ↓Discard')
    lines.push('')
    lines.push(pendingText || '(empty)')
  } else if (phase === 'sending') {
    lines.push(`Sending → ${settings.sessionName}`)
    lines.push('')
    lines.push(pendingText.slice(0, 200))
  } else if (phase === 'unconfigured') {
    const s = statusForCurrentPhase()
    lines.push('headlenss')
    lines.push(s.text)
  } else {
    lines.push('headlenss')
  }
  return lines.join('\n')
}

/** 行ごとに右側の空白を落とし、末尾の空行を全部捨てた結果の配列を返す */
function normalizeOutput(text: string): string[] {
  const lines = text.split('\n').map((l) => l.replace(/[ \t]+$/, ''))
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** Dashboard 用: 末尾 n 行 (スクロール非依存) */
function tailLines(text: string, n: number): string {
  return normalizeOutput(text).slice(-n).join('\n')
}

/** G2 rootlist 画面: Claude Code 起動中の tmux 一覧 (待機状態は記号で示す) */
function buildRootListView(): string {
  const items = claudeSessions
  if (items.length === 0) {
    return '(Claude Code が動いている tmux が無い)\n\ntmux 内で `claude` を起動してください'
  }
  const total = items.length
  let start = rootCursor - Math.floor(ROOT_LIST_VISIBLE / 2)
  start = Math.max(0, start)
  start = Math.min(start, Math.max(0, total - ROOT_LIST_VISIBLE))

  const lines: string[] = []
  for (let i = start; i < Math.min(start + ROOT_LIST_VISIBLE, total); i++) {
    const s = items[i]
    const cursor = i === rootCursor ? '▶ ' : '  '
    const mark = claudeStatusMark(s)
    lines.push(`${cursor}${s.tmuxSessionName} ${mark}`)
  }
  return lines.join('\n')
}

/** Claude Code 承認/質問への応答画面 */
function buildCcResponseView(): string {
  if (!claudePending) return '(no pending)'
  const lines: string[] = []
  if (claudePending.kind === 'permission') {
    lines.push(`⏸ ${claudePending.toolName} の承認`)
    lines.push('')
    const summary = summarizeToolInput(claudePending.toolInput).slice(0, CHAT_WRAP_WIDTH * 3)
    if (summary) lines.push(summary)
    lines.push('')
    const opts = ['Allow', 'Deny']
    for (let i = 0; i < opts.length; i++) {
      lines.push((i === respondCursor ? '▶ ' : '  ') + opts[i])
    }
  } else {
    const q = claudePending.questions?.[0]
    if (!q) return '(question is empty)'
    lines.push('? ' + q.question.slice(0, CHAT_WRAP_WIDTH))
    lines.push('')
    const opts = q.options ?? []
    for (let i = 0; i < opts.length; i++) {
      lines.push((i === respondCursor ? '▶ ' : '  ') + opts[i].label)
    }
  }
  return lines.join('\n')
}

function summarizeToolInput(input: unknown): string {
  if (input == null) return ''
  if (typeof input === 'string') return input
  try {
    return JSON.stringify(input).replace(/[{}",]/g, ' ').replace(/\s+/g, ' ').trim()
  } catch {
    return ''
  }
}

/** チャット項目をG2レンズ用に整形 (役割ごとの prefix + word-wrap、even-toolkit流) */
function formatChatLines(items: ChatItem[], maxChars: number): string[] {
  const out: string[] = []
  for (const item of items) {
    const prefix = item.role === 'user' ? '> ' : ''
    const indent = ' '.repeat(prefix.length)
    const text = item.text.replace(/\r/g, '').trim()
    if (!text) continue
    const paragraphs = text.split('\n')
    let isFirst = true
    for (const para of paragraphs) {
      const wrapped = wrapText(para, maxChars - prefix.length)
      for (const line of wrapped) {
        out.push((isFirst ? prefix : indent) + line)
        isFirst = false
      }
    }
    out.push('')  // メッセージ間の区切り
  }
  while (out.length > 0 && out[out.length - 1] === '') out.pop()
  return out
}

function wrapText(text: string, width: number): string[] {
  if (width <= 0 || text.length <= width) return [text || '']
  const out: string[] = []
  let s = text
  while (s.length > width) {
    let cut = s.lastIndexOf(' ', width)
    if (cut < width / 2) cut = width  // word boundary が極端に短ければハードブレーク
    out.push(s.slice(0, cut).trimEnd())
    s = s.slice(cut).trimStart()
  }
  if (s) out.push(s)
  return out
}

/** chat 行配列を scrollOffset を考慮して n 行 window する */
function chatWindow(lines: string[], n: number): string[] {
  if (lines.length === 0) return []
  const total = lines.length
  const end = Math.max(n, total - scrollOffset)
  const start = Math.max(0, end - n)
  return lines.slice(start, end)
}

/** Lens 用: scrollOffset を考慮した表示ウィンドウ */
function lensWindow(text: string, n: number): string {
  const lines = normalizeOutput(text)
  if (lines.length === 0) return ''
  const total = lines.length
  // 末尾から scrollOffset 行戻った位置を「ウィンドウの下端」にする
  const end = Math.max(n, total - scrollOffset)
  const start = Math.max(0, end - n)
  return lines.slice(start, end).join('\n')
}

function maxChatScrollOffset(): number {
  const formatted = formatChatLines(claudeChat, CHAT_WRAP_WIDTH)
  return Math.max(0, formatted.length - CHAT_DISPLAY_LINES)
}

function isScrolled(): boolean {
  return scrollOffset > 0
}

function scrollBack(): void {
  if (phase !== 'idle') return
  const max = maxChatScrollOffset()
  if (max === 0) return
  scrollOffset = Math.min(max, scrollOffset + CHAT_DISPLAY_LINES)
  void refreshG2(true)
}

function scrollForward(): void {
  if (phase !== 'idle') return
  if (scrollOffset === 0) return
  scrollOffset = Math.max(0, scrollOffset - CHAT_DISPLAY_LINES)
  void refreshG2(true)
}

function resetScroll(): void {
  scrollOffset = 0
}

function buildG2Footer(): string {
  switch (phase) {
    case 'rootlist':
      if (claudeSessions.length === 0) return 'No Claude Code session'
      return `Click: Open  ↑↓ Nav  (${rootCursor + 1}/${claudeSessions.length})`
    case 'cc-response':
      return '↑↓ 選択  Click: 確定'
    case 'recording': return 'Click: Stop'
    case 'finalizing': return 'Finalizing…'
    case 'pending': return '↑ Send  ↓ Discard'
    case 'sending': return 'Sending…'
    case 'unconfigured': return 'Configure in app'
    case 'idle':
      if (isScrolled()) return `↑ older  ↓ newer  (back ${scrollOffset})`
      return 'Click: Rec  ↑↓ Scroll  ⊕⊕ Back'
    default: return ''
  }
}

async function refreshG2(force = false): Promise<void> {
  if (!bridge) return
  const now = performance.now()
  if (!force && now - g2RefreshLastAt < G2_REFRESH_THROTTLE_MS) return
  g2RefreshLastAt = now
  try {
    await updateContent(buildG2Content())
    await updateFooter(buildG2Footer())
  } catch (err) {
    log(`G2 refresh error: ${err}`)
  }
}

// ─── Sessions ──────────────────────────────────────────────────────────
function renderSessionPills(): void {
  sessionPillsEl.innerHTML = ''
  if (!settings.serverBaseUrl) {
    sessionPillsEl.innerHTML = '<div class="muted small">Server URL を設定してください</div>'
    return
  }
  if (!serverProbeOk) {
    sessionPillsEl.innerHTML = `<div class="muted small">サーバ未接続: ${escapeHtml(serverErrorMsg) || '?'}</div>`
    return
  }
  if (lastSessions.length === 0) {
    sessionPillsEl.innerHTML = '<div class="muted small">セッション無し。下から作成</div>'
    return
  }
  for (const s of lastSessions) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'pill' + (s.name === settings.sessionName ? ' active' : '')
    btn.dataset.action = 'select'
    btn.dataset.name = s.name
    btn.innerHTML = `<span>${escapeHtml(s.name)}</span>` +
      `<span class="pill-kill" data-action="kill" data-name="${escapeAttr(s.name)}" aria-label="kill ${escapeAttr(s.name)}">✕</span>`
    sessionPillsEl.appendChild(btn)
  }
}

sessionPillsEl.addEventListener('click', (e) => {
  const target = e.target as HTMLElement
  const action = target.closest<HTMLElement>('[data-action]')?.dataset.action
  const name = target.closest<HTMLElement>('[data-name]')?.dataset.name
  if (!action || !name) return

  if (action === 'kill') {
    e.stopPropagation()
    void killSession(name)
    return
  }
  if (action === 'select') {
    if (settings.sessionName === name) return
    settings.sessionName = name
    void persistSettings()
    renderSessionPills()
    recomputePhase()
    tmuxOutput = ''
    resetScroll()
    void refreshClaudeData()
  }
})

reloadSessionsBtn.addEventListener('click', () => {
  void reloadSessions(true)
})

newSessionForm.addEventListener('submit', (e) => {
  e.preventDefault()
  const name = newSessionInput.value.trim()
  if (!name) return
  void createAndSelectSession(name)
})

async function reloadSessions(verbose = false): Promise<void> {
  if (!settings.serverBaseUrl || !serverProbeOk) return
  try {
    lastSessions = await client.listSessions()
    if (verbose) log(`sessions: ${lastSessions.map((s) => s.name).join(', ') || '(none)'}`)
    if (lastSessions.length > 0 && !lastSessions.some((s) => s.name === settings.sessionName)) {
      settings.sessionName = lastSessions[0].name
      void persistSettings()
    }
    // rootlist のカーソル位置がオーバーランしないようクランプ
    if (rootCursor >= lastSessions.length) {
      rootCursor = Math.max(0, lastSessions.length - 1)
    }
    renderSessionPills()
    paintStatus()
    if (phase === 'rootlist') void refreshG2(true)
  } catch (e) {
    log(`listSessions error: ${(e as Error).message}`)
  }
}

async function createAndSelectSession(name: string): Promise<void> {
  if (!settings.serverBaseUrl || !serverProbeOk) {
    log('cannot create session: server not reachable')
    return
  }
  try {
    await client.createSession(name)
    log(`created session: ${name}`)
    settings.sessionName = name
    await persistSettings()
    newSessionInput.value = ''
    await reloadSessions()
    recomputePhase()
  } catch (e) {
    log(`createSession error: ${(e as Error).message}`)
  }
}

// ─── Claude Code セッション/チャット/承認待ち データ取得 ──────────────────
function setOutputDisplay(text: string, kind: 'ok' | 'muted' | 'err'): void {
  // dashboard 側のミラー欄。chat 表示用に再利用。
  tmuxOutputEl.textContent = text
  tmuxOutputEl.classList.toggle('muted', kind !== 'ok')
  tmuxOutputEl.classList.toggle('err', kind === 'err')
}

/** Claude Code 起動中の tmux session 一覧を取得 (rootlist 用) */
async function reloadClaudeSessions(): Promise<void> {
  if (!serverProbeOk) return
  try {
    const next = await client.listClaudeSessions()
    const changed =
      next.length !== claudeSessions.length ||
      next.some((s, i) => s.tmuxSessionName !== claudeSessions[i]?.tmuxSessionName || s.status !== claudeSessions[i]?.status)
    claudeSessions = next
    if (rootCursor >= claudeSessions.length) {
      rootCursor = Math.max(0, claudeSessions.length - 1)
    }
    // rootlist を見ている間は中身が変わったら即レンズ再描画
    if (changed && phase === 'rootlist') void refreshG2(true)
  } catch (e) {
    log(`listClaudeSessions error: ${(e as Error).message}`)
  }
}

/** 現在選択中セッションの chat と pending を取得 (idle / cc-response 用) */
async function refreshClaudeData(): Promise<void> {
  if (!serverProbeOk) {
    setOutputDisplay(`(server not reachable: ${serverErrorMsg || '?'})`, 'err')
    return
  }
  if (!settings.sessionName) {
    setOutputDisplay('(no session selected)', 'muted')
    return
  }
  try {
    const [chat, pending] = await Promise.all([
      client.getClaudeChat(settings.sessionName),
      client.getClaudePending(settings.sessionName),
    ])
    // chat: scrollback 中なら新着分だけオフセット繰り上げ
    if (scrollOffset > 0) {
      const oldLen = formatChatLines(claudeChat, CHAT_WRAP_WIDTH).length
      const newLen = formatChatLines(chat, CHAT_WRAP_WIDTH).length
      const delta = newLen - oldLen
      if (delta > 0) {
        const max = Math.max(0, newLen - CHAT_DISPLAY_LINES)
        scrollOffset = Math.min(max, scrollOffset + delta)
      }
    }
    claudeChat = chat
    claudePending = pending
    if (chat.length > 0) {
      const lastUser = [...chat].reverse().find((c) => c.role === 'user')?.text ?? ''
      const lastAssistant = [...chat].reverse().find((c) => c.role === 'assistant')?.text ?? ''
      setOutputDisplay(
        `${chat.length} messages\n` +
        (lastUser ? `> ${lastUser.slice(0, 200)}\n` : '') +
        (lastAssistant ? `${lastAssistant.slice(0, 200)}` : ''),
        'ok',
      )
      if (!outputFetchOkLogged) {
        log(`getClaudeChat ok: ${chat.length} items from "${settings.sessionName}"`)
        outputFetchOkLogged = true
      }
    } else {
      setOutputDisplay(`(no chat yet for "${settings.sessionName}")`, 'muted')
    }
    if (phase === 'idle' || phase === 'cc-response') void refreshG2(true)
  } catch (e) {
    const msg = (e as Error).message
    setOutputDisplay(`error: ${msg}`, 'err')
    log(`refreshClaudeData error: ${msg}`)
    outputFetchOkLogged = false
  }
}

function startOutputPolling(): void {
  if (outputPollTimer) clearInterval(outputPollTimer)
  outputPollTimer = setInterval(() => {
    // Recording / pending / sending / finalizing 中は claude polling を止める
    if (phase === 'recording' || phase === 'finalizing' || phase === 'pending' || phase === 'sending') return
    if (phase === 'rootlist') {
      void reloadClaudeSessions()
    } else if (phase === 'idle' || phase === 'cc-response') {
      void reloadClaudeSessions()
      void refreshClaudeData()
    }
  }, CC_POLL_INTERVAL_MS)
}

reloadOutputBtn.addEventListener('click', () => { void refreshClaudeData() })

async function killSession(name: string): Promise<void> {
  if (!confirm(`Kill session "${name}"?`)) return
  try {
    await client.killSession(name)
    log(`killed session: ${name}`)
    if (settings.sessionName === name) {
      const remaining = lastSessions.filter((s) => s.name !== name)
      if (remaining.length > 0) {
        settings.sessionName = remaining[0].name
        await persistSettings()
      }
    }
    await reloadSessions()
    recomputePhase()
  } catch (e) {
    log(`killSession error: ${(e as Error).message}`)
  }
}

// ─── History ───────────────────────────────────────────────────────────
function addHistoryEntry(entry: Omit<HistoryEntry, 'id' | 'timestamp'>): void {
  const e: HistoryEntry = {
    id: ++historyCounter,
    timestamp: Date.now(),
    ...entry,
  }
  history = [e, ...history].slice(0, HISTORY_LIMIT)
  renderHistory()
}

function renderHistory(): void {
  if (history.length === 0) {
    historyListEl.innerHTML = '<li class="muted small">(まだ送信していません)</li>'
    return
  }
  historyListEl.innerHTML = ''
  const now = Date.now()
  for (const h of history) {
    const li = document.createElement('li')
    li.className = `history-item ${h.ok ? 'ok' : 'err'}`
    const icon = h.ok ? '✓' : '✗'
    const ago = formatAgo(now - h.timestamp)
    const meta = h.ok
      ? `${ago} · ${h.durationMs.toFixed(0)}ms`
      : `${ago} · failed`
    const body = h.ok ? h.text : `${h.text || '(empty)'}\n→ ${h.errorMsg ?? 'error'}`
    li.innerHTML =
      `<span class="history-icon">${icon}</span>` +
      `<div class="history-text">${escapeHtml(body)}<span class="target">→ ${escapeHtml(h.session)}</span></div>` +
      `<span class="history-meta">${escapeHtml(meta)}</span>`
    historyListEl.appendChild(li)
  }
}

function formatAgo(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.floor(ms / 1000))}s ago`
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`
  return `${Math.floor(ms / 3_600_000)}h ago`
}

clearHistoryBtn.addEventListener('click', () => {
  history = []
  renderHistory()
})

setInterval(renderHistory, 60_000)

// ─── Settings UI ───────────────────────────────────────────────────────
function renderSettings(): void {
  serverUrlEl.value = settings.serverBaseUrl
  submitOnSendEl.checked = settings.submitOnSend
  smApiKeyEl.value = settings.speechmaticsApiKey
  smLangEl.value = settings.speechmaticsLang
  smOperatingPointEl.value = settings.speechmaticsOperatingPoint
}

async function persistSettings(): Promise<void> {
  await saveSettings(bridge, settings)
}

function applyClientBase(): void {
  client.setBase(settings.serverBaseUrl)
}

serverUrlEl.addEventListener('input', () => {
  settings.serverBaseUrl = serverUrlEl.value.trim()
  applyClientBase()
  void persistSettings()
  scheduleProbe()
})

submitOnSendEl.addEventListener('change', () => {
  settings.submitOnSend = submitOnSendEl.checked
  void persistSettings()
})

smApiKeyEl.addEventListener('change', () => {
  settings.speechmaticsApiKey = smApiKeyEl.value.trim()
  void persistSettings()
  recomputePhase()
})

smLangEl.addEventListener('change', () => {
  const v = smLangEl.value.trim() || DEFAULT_SETTINGS.speechmaticsLang
  settings.speechmaticsLang = v
  smLangEl.value = v
  void persistSettings()
})

smOperatingPointEl.addEventListener('change', () => {
  const v = smOperatingPointEl.value as OperatingPoint
  settings.speechmaticsOperatingPoint = v === 'standard' ? 'standard' : 'enhanced'
  void persistSettings()
})

function scheduleProbe(): void {
  if (probeDebounceTimer) clearTimeout(probeDebounceTimer)
  setProbeText('busy', '確認中…')
  probeDebounceTimer = setTimeout(() => {
    probeDebounceTimer = null
    void probeServer()
  }, PROBE_DEBOUNCE_MS)
}

function setProbeText(kind: 'ok' | 'err' | 'busy' | 'muted', text: string): void {
  serverProbeText.className = `probe small ${kind === 'muted' ? 'muted' : kind}`
  serverProbeText.textContent = text
}

async function probeServer(): Promise<void> {
  if (!settings.serverBaseUrl) {
    serverProbeOk = false
    serverErrorMsg = 'unset'
    setProbeText('muted', '未設定')
    renderSessionPills()
    recomputePhase()
    return
  }
  setProbeText('busy', '確認中…')
  try {
    const res = await client.health()
    if (res.ok) {
      serverProbeOk = true
      serverErrorMsg = ''
      await reloadSessions()
      setProbeText('ok', `OK · sessions: ${lastSessions.length}`)
    } else {
      serverProbeOk = false
      serverErrorMsg = 'health returned ok=false'
      setProbeText('err', serverErrorMsg)
    }
  } catch (e) {
    serverProbeOk = false
    serverErrorMsg = (e as Error).message
    setProbeText('err', serverErrorMsg)
    log(`probe error: ${serverErrorMsg}`)
  } finally {
    renderSessionPills()
    recomputePhase()
  }
}

// ─── Onboarding ────────────────────────────────────────────────────────
type View = 'onboarding' | 'dashboard'

function setView(v: View): void {
  bodyEl.dataset.view = v
}

function showOnboardingStep(n: 1 | 2): void {
  for (const el of obSteps) {
    const step = Number(el.dataset.step)
    el.hidden = step !== n
  }
  if (n === 1) obServerUrlEl.focus()
  if (n === 2) obSmKeyEl.focus()
}

let obProbeTimer: ReturnType<typeof setTimeout> | null = null

function setObProbe(kind: 'ok' | 'err' | 'busy' | 'muted', text: string): void {
  obServerProbeEl.className = `probe small ${kind === 'muted' ? 'muted' : kind}`
  obServerProbeEl.textContent = text
}

async function obProbe(url: string): Promise<void> {
  obNext1Btn.disabled = true
  setObProbe('busy', '確認中…')
  const tmp = new HeadlenssClient(url)
  try {
    const res = await tmp.health()
    if (!res.ok) throw new Error('health returned ok=false')
    const sessions = await tmp.listSessions()
    setObProbe('ok', `OK · ${sessions.length} session${sessions.length === 1 ? '' : 's'}`)
    obNext1Btn.disabled = false
  } catch (e) {
    setObProbe('err', `接続できません: ${(e as Error).message}`)
    obNext1Btn.disabled = true
  }
}

obServerUrlEl.addEventListener('input', () => {
  const url = obServerUrlEl.value.trim()
  if (!url) {
    setObProbe('muted', 'URL を入れると自動で確認します')
    obNext1Btn.disabled = true
    return
  }
  if (obProbeTimer) clearTimeout(obProbeTimer)
  setObProbe('busy', '入力中…')
  obProbeTimer = setTimeout(() => {
    obProbeTimer = null
    void obProbe(url)
  }, PROBE_DEBOUNCE_MS)
})

obNext1Btn.addEventListener('click', () => {
  settings.serverBaseUrl = obServerUrlEl.value.trim()
  applyClientBase()
  void persistSettings()
  showOnboardingStep(2)
})

obSmKeyEl.addEventListener('input', () => {
  obFinishBtn.disabled = obSmKeyEl.value.trim().length === 0
})

obBackBtn.addEventListener('click', (e) => {
  e.preventDefault()
  showOnboardingStep(1)
})

obFinishBtn.addEventListener('click', () => {
  void finishOnboarding()
})

async function finishOnboarding(): Promise<void> {
  const key = obSmKeyEl.value.trim()
  if (!key) return
  settings.speechmaticsApiKey = key
  await persistSettings()
  try {
    const sessions = await client.listSessions()
    if (sessions.length === 0) {
      log('Auto-creating session "main"')
      await client.createSession('main')
      settings.sessionName = 'main'
    } else if (!sessions.some((s) => s.name === settings.sessionName)) {
      settings.sessionName = sessions[0].name
    }
    await persistSettings()
  } catch (e) {
    log(`finishOnboarding session setup error: ${(e as Error).message}`)
  }
  renderSettings()
  setView('dashboard')
  await probeServer()
}

function isConfigured(s: Settings): boolean {
  return Boolean(s.serverBaseUrl && s.speechmaticsApiKey)
}

resetOnboardingBtn.addEventListener('click', () => {
  obServerUrlEl.value = settings.serverBaseUrl
  obSmKeyEl.value = settings.speechmaticsApiKey
  obFinishBtn.disabled = !settings.speechmaticsApiKey
  setObProbe('muted', '確認中…')
  showOnboardingStep(1)
  setView('onboarding')
  if (settings.serverBaseUrl) void obProbe(settings.serverBaseUrl)
})

// ─── Recording → RT → tmux ─────────────────────────────────────────────
function startRecordingTimer(): void {
  stopRecordingTimer()
  recordingTimer = setInterval(() => {
    if (phase !== 'recording') return
    durationEl.textContent = `${getRecordingSeconds().toFixed(1)}s`
    paintStatus()
    void refreshG2()
    if (getRecordingSeconds() >= MAX_RECORDING_SEC) {
      log(`Reached safe limit ${MAX_RECORDING_SEC}s, auto-stop.`)
      void toggleRecording()
    }
  }, 250)
}

function stopRecordingTimer(): void {
  if (recordingTimer) {
    clearInterval(recordingTimer)
    recordingTimer = null
  }
}

function updateRecordButton(): void {
  if (phase === 'finalizing' || phase === 'sending') {
    recordBtn.disabled = true
    recordBtn.textContent = phase === 'finalizing' ? 'Finalizing…' : 'Sending…'
    recordBtn.classList.remove('recording')
    return
  }
  if (phase === 'recording') {
    recordBtn.disabled = false
    recordBtn.textContent = 'Stop'
    recordBtn.classList.add('recording')
    return
  }
  if (phase === 'pending') {
    recordBtn.disabled = true
    recordBtn.textContent = '↑送信 / ↓破棄'
    recordBtn.classList.remove('recording')
    return
  }
  if (phase === 'rootlist') {
    recordBtn.disabled = true
    recordBtn.textContent = 'Pick session on G2'
    recordBtn.classList.remove('recording')
    return
  }
  recordBtn.disabled = phase !== 'idle'
  recordBtn.textContent = 'Record'
  recordBtn.classList.remove('recording')
}

async function startRecording(): Promise<void> {
  if (!bridge) {
    log('cannot record: G2 bridge not available')
    return
  }
  if (!settings.speechmaticsApiKey || !settings.serverBaseUrl || !settings.sessionName) {
    log('startRecording blocked: not configured')
    return
  }

  resetPcmCounter()
  liveTranscript = ''
  durationEl.textContent = '0.0s'
  resetScroll()

  // 1. UI を即座に recording 画面へ遷移 (体感ラグを減らす)
  phase = 'recording'
  startRecordingTimer()
  paintStatus()
  updateRecordButton()
  void refreshG2(true)

  // 2. Speechmatics RT 接続 + マイク起動 を非同期で進める。
  //    途中でユーザが停止した場合に二重起動を防ぐため、session 同一性で gard する。
  const localBridge = bridge
  const session = new SpeechmaticsRT()
  rtSession = session

  const revertToIdle = () => {
    if (rtSession === session && phase === 'recording') {
      stopRecordingTimer()
      try { session.abort() } catch { /* ignore */ }
      rtSession = null
      phase = 'idle'
      paintStatus()
      updateRecordButton()
      void refreshG2(true)
    }
  }

  void (async () => {
    try {
      await session.start({
        apiKey: settings.speechmaticsApiKey,
        language: settings.speechmaticsLang,
        operatingPoint: settings.speechmaticsOperatingPoint,
        onPartial: (text) => {
          liveTranscript = text
          void refreshG2()
        },
        onFinal: (text) => {
          liveTranscript = text
          void refreshG2()
        },
        onError: (err) => log(`RT error: ${err.message}`),
      })
      log('Speechmatics RT connected')
    } catch (err) {
      log(`RT connect failed: ${(err as Error).message}`)
      revertToIdle()
      return
    }

    // 接続完了するまでにユーザが停止していたら、ここで打ち切り
    if (rtSession !== session || phase !== 'recording') {
      try { session.abort() } catch { /* ignore */ }
      return
    }

    // 3. G2マイク開始
    try {
      const ok = await localBridge.audioControl(true)
      if (ok === false) {
        log('audioControl(true) returned false')
        revertToIdle()
      }
    } catch (err) {
      log(`audioControl error: ${err}`)
      revertToIdle()
    }
  })()
}

/** 録音停止 → ASR 確定 → pending 状態へ。送信はしない (ユーザの↑/↓判断待ち) */
async function stopRecordingToPending(): Promise<void> {
  stopRecordingTimer()
  phase = 'finalizing'
  paintStatus()
  updateRecordButton()
  void refreshG2(true)

  // G2マイク停止
  try {
    if (bridge) await bridge.audioControl(false)
  } catch (err) {
    log(`Stop error: ${err}`)
  }

  const seconds = getRecordingSeconds()
  if (seconds < MIN_RECORDING_SEC || getPcmByteLength() === 0) {
    log(`Recording too short: ${seconds.toFixed(2)}s`)
    rtSession?.abort()
    rtSession = null
    durationEl.textContent = '0.0s'
    pendingText = ''
    liveTranscript = ''
    phase = 'idle'
    recomputePhase()
    return
  }

  const rt = rtSession
  if (!rt) {
    phase = 'idle'
    recomputePhase()
    return
  }
  let text = ''
  const t0 = performance.now()
  try {
    text = (await rt.stop()).trim()
    log(`RT final: "${text.slice(0, 80)}" (${(performance.now() - t0).toFixed(0)}ms)`)
  } catch (e) {
    const errorMsg = (e as Error).message
    log(`RT stop error: ${errorMsg}`)
    addHistoryEntry({
      text: liveTranscript || '(ASR failed)',
      session: settings.sessionName,
      ok: false,
      durationMs: performance.now() - t0,
      errorMsg,
    })
    rtSession = null
    durationEl.textContent = '0.0s'
    pendingText = ''
    liveTranscript = ''
    phase = 'idle'
    recomputePhase()
    return
  } finally {
    rtSession = null
  }

  durationEl.textContent = '0.0s'

  if (!text) {
    log('RT returned empty text — auto-discarding')
    pendingText = ''
    liveTranscript = ''
    phase = 'idle'
    recomputePhase()
    return
  }

  // pending — ユーザの↑/↓を待つ
  pendingText = text
  liveTranscript = ''
  phase = 'pending'
  paintStatus()
  updateRecordButton()
  updatePendingUI()
  void refreshG2(true)
}

/** pending → サーバ送信 → idle */
async function confirmAndSend(): Promise<void> {
  if (phase !== 'pending') return
  const text = pendingText
  if (!text) {
    pendingText = ''
    phase = 'idle'
    recomputePhase()
    return
  }
  phase = 'sending'
  paintStatus()
  updateRecordButton()
  updatePendingUI()
  void refreshG2(true)

  const t0 = performance.now()
  try {
    await client.sendKeys(settings.sessionName, {
      text,
      submit: settings.submitOnSend,
    })
    log(`sendKeys ok → ${settings.sessionName}`)
    addHistoryEntry({
      text,
      session: settings.sessionName,
      ok: true,
      durationMs: performance.now() - t0,
    })
  } catch (e) {
    const errorMsg = (e as Error).message
    log(`sendKeys error: ${errorMsg}`)
    addHistoryEntry({
      text,
      session: settings.sessionName,
      ok: false,
      durationMs: performance.now() - t0,
      errorMsg,
    })
  } finally {
    pendingText = ''
    phase = 'idle'
    resetScroll()
    recomputePhase()
    // 送信直後に出力ミラーを取り直し (反映を見える化)
    void refreshClaudeData()
  }
}

/** pending → 破棄 → idle */
function discardPending(): void {
  if (phase !== 'pending') return
  log('pending discarded')
  pendingText = ''
  phase = 'idle'
  recomputePhase()
}

async function toggleRecording(): Promise<void> {
  if (phase === 'finalizing' || phase === 'sending') return
  if (phase === 'recording') {
    await stopRecordingToPending()
  } else if (phase === 'pending') {
    // 録音中じゃないクリックは何もしない (誤操作防止)
    return
  } else if (phase === 'rootlist') {
    openSelectedFromRoot()
  } else if (phase === 'idle') {
    // pending があるなら音声入力ではなく応答画面に遷移
    if (claudePending) {
      respondCursor = 0
      phase = 'cc-response'
      paintStatus()
      void refreshG2(true)
      updateRecordButton()
    } else {
      await startRecording()
    }
  } else if (phase === 'cc-response') {
    await submitPendingResponse()
  } else {
    settingsDetails.open = true
  }
}

// ─── rootlist ──────────────────────────────────────────────────────────
function moveRootCursor(delta: number): void {
  if (phase !== 'rootlist') return
  if (claudeSessions.length === 0) return
  rootCursor = (rootCursor + delta + claudeSessions.length) % claudeSessions.length
  void refreshG2(true)
}

function openSelectedFromRoot(): void {
  if (phase !== 'rootlist') return
  const sel = claudeSessions[rootCursor]
  if (!sel) return
  settings.sessionName = sel.tmuxSessionName
  void persistSettings()
  log(`Opened Claude session: ${sel.tmuxSessionName}`)
  claudeChat = []
  claudePending = null
  resetScroll()
  phase = 'idle'
  paintStatus()
  void refreshG2(true)
  updateRecordButton()
  void refreshClaudeData()
}

function moveRespondCursor(delta: number): void {
  if (phase !== 'cc-response') return
  const total = pendingOptionCount()
  if (total === 0) return
  respondCursor = (respondCursor + delta + total) % total
  void refreshG2(true)
}

function pendingOptionCount(): number {
  if (!claudePending) return 0
  if (claudePending.kind === 'permission') return 2
  return claudePending.questions?.[0]?.options?.length ?? 0
}

async function submitPendingResponse(): Promise<void> {
  if (phase !== 'cc-response' || !claudePending) return
  const sessionName = settings.sessionName
  if (!sessionName) return
  try {
    if (claudePending.kind === 'permission') {
      const decision = respondCursor === 0 ? 'allow' : 'deny'
      await client.respondClaude(sessionName, { kind: 'permission', decision })
      log(`responded permission: ${decision}`)
    } else {
      const q = claudePending.questions?.[0]
      const opt = q?.options?.[respondCursor]
      if (q && opt) {
        await client.respondClaude(sessionName, {
          kind: 'question',
          answers: [{ question: q.question, option: opt.label }],
        })
        log(`responded question: ${opt.label}`)
      }
    }
  } catch (e) {
    log(`respond error: ${(e as Error).message}`)
  } finally {
    claudePending = null
    respondCursor = 0
    phase = 'idle'
    paintStatus()
    updateRecordButton()
    void refreshG2(true)
    void refreshClaudeData()
  }
}

function backToRoot(): void {
  if (phase !== 'idle') return
  log('back to root list')
  syncRootCursor()
  phase = 'rootlist'
  paintStatus()
  void refreshG2(true)
  updateRecordButton()
}

confirmBtn.addEventListener('click', () => { void confirmAndSend() })
discardBtn.addEventListener('click', () => { discardPending() })

// ─── Boot ──────────────────────────────────────────────────────────────
function setupLogToolbar(): void {
  const copyBtn = document.getElementById('copyLogBtn') as HTMLButtonElement | null
  const clearBtn = document.getElementById('clearLogBtn') as HTMLButtonElement | null

  copyBtn?.addEventListener('click', async () => {
    const text = logEl.textContent ?? ''
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text)
      } else {
        const ta = document.createElement('textarea')
        ta.value = text
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        document.body.removeChild(ta)
      }
      copyBtn.textContent = 'Copied!'
      setTimeout(() => { copyBtn.textContent = 'Copy' }, 1500)
    } catch (err) {
      console.error('[headlenss] copy failed', err)
    }
  })

  clearBtn?.addEventListener('click', () => {
    logEl.textContent = ''
  })
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms)
    promise.then(
      (v) => { window.clearTimeout(timer); resolve(v) },
      (e) => { window.clearTimeout(timer); reject(e) },
    )
  })
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  } as Record<string, string>)[c])
}
function escapeAttr(s: string): string {
  return escapeHtml(s)
}

async function boot(): Promise<void> {
  setupLogToolbar()

  // 1. Bridge 接続 (必須)
  try {
    bridge = await withTimeout(waitForEvenAppBridge(), BRIDGE_TIMEOUT_MS)
    log('Connected to Even bridge')
  } catch {
    log('Even bridge not available — このアプリはG2 SDK経由でしか動作しません')
  }

  // 2. G2画面初期化
  if (bridge) {
    initRenderer(bridge)
    setEventHandlers({
      // rootlist: 上下=カーソル / click=open
      // pending:  上=送信 / 下=破棄
      // idle:     上=過去ログへ / 下=新しい方へ (lens内独自スクロール)
      onScrollUp: () => {
        if (phase === 'rootlist') moveRootCursor(-1)
        else if (phase === 'pending') void confirmAndSend()
        else if (phase === 'idle') scrollBack()
        else if (phase === 'cc-response') moveRespondCursor(-1)
      },
      onScrollDown: () => {
        if (phase === 'rootlist') moveRootCursor(1)
        else if (phase === 'pending') discardPending()
        else if (phase === 'idle') scrollForward()
        else if (phase === 'cc-response') moveRespondCursor(1)
      },
      onClick: () => { void toggleRecording() },
      // 二重クリック: session 画面 → root に戻る、 root画面ではOSの終了ダイアログ
      onDoubleClick: () => {
        if (phase === 'idle') backToRoot()
        else if (phase === 'cc-response') {
          // 応答キャンセル → idle に戻る
          phase = 'idle'
          respondCursor = 0
          paintStatus()
          void refreshG2(true)
          updateRecordButton()
        } else if (phase === 'rootlist') {
          // Even Hub 審査要件: ルート画面の double-tap は OS 終了ダイアログ
          void bridge?.shutDownPageContainer(1)
        }
      },
      onAudio: (pcm) => {
        if (phase !== 'recording') return
        trackPcmFrame(pcm)
        rtSession?.send(pcm)
      },
      // G2 アプリ画面に戻ってきたとき: ページを再生成して最新の tmux 出力を再描画
      onForegroundEnter: () => {
        log('foreground enter — re-rendering lens')
        resetPageState()
        void (async () => {
          try {
            await showScreen(buildG2Content(), buildG2Footer())
          } catch (err) {
            log(`re-render error: ${err}`)
          }
          void refreshClaudeData()
        })()
      },
      onForegroundExit: () => {
        // ページが破棄されている可能性に備え、次回入場時に createStartUpPageContainer に戻す
        resetPageState()
      },
      onLog: (msg) => log(msg),
    })
    try {
      await showScreen(buildG2Content(), buildG2Footer())
      bridge.onEvenHubEvent(onEvenHubEvent)
    } catch (err) {
      log(`G2 initial render error: ${err}`)
    }
  }

  // 3. 設定ロード
  settings = await loadSettings(bridge)
  log(`Loaded settings: server=${settings.serverBaseUrl || '(none)'} session=${settings.sessionName}`)
  applyClientBase()
  renderSettings()

  // 4. UI events
  recordBtn.addEventListener('click', () => { void toggleRecording() })

  // 5. 初回 or 設定済みかで表示切替
  if (!isConfigured(settings)) {
    obServerUrlEl.value = settings.serverBaseUrl
    obSmKeyEl.value = settings.speechmaticsApiKey
    obFinishBtn.disabled = !settings.speechmaticsApiKey
    showOnboardingStep(settings.serverBaseUrl ? 2 : 1)
    setView('onboarding')
    if (settings.serverBaseUrl) void obProbe(settings.serverBaseUrl)
  } else {
    setView('dashboard')
  }

  // 6. 状態同期 + サーバ疎通
  renderHistory()
  recomputePhase()
  if (settings.serverBaseUrl) {
    await probeServer()
  } else {
    setProbeText('muted', '未設定')
  }

  // セッション一覧を定期的に更新
  if (sessionsRefreshTimer) clearInterval(sessionsRefreshTimer)
  sessionsRefreshTimer = setInterval(() => {
    if (phase === 'recording' || phase === 'finalizing' || phase === 'pending' || phase === 'sending') return
    void reloadSessions()
  }, SESSIONS_REFRESH_MS)

  // tmux 出力ポーリング (idle時のみ実行)
  startOutputPolling()
  if (serverProbeOk) {
    // 起動直後にレンズが空表示になるのを避けるため、ポーリング待たずに即フェッチ
    void reloadClaudeSessions()
    void refreshClaudeData()
    // 念のため数百ms後にもう一度叩く (Claude Code 側の registry 書き込みタイミング次第で
    // 1回目で見えないケースがあるため)
    setTimeout(() => {
      if (!serverProbeOk) return
      void reloadClaudeSessions()
    }, 500)
  }
}

boot().catch((err) => {
  log(`Fatal: ${err}`)
  phase = 'error'
  serverErrorMsg = (err as Error).message
  paintStatus()
})
