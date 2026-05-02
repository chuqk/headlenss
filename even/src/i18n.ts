// 簡易 i18n。WebView 全体と G2 レンズ表示の双方が同じテーブルを参照する。
//   currentLanguage を切り替えると次回 t() 呼び出しから新言語が返る。
//   WebView はセレクタ変更時に applyTranslations() で全 data-i18n 要素を即時更新、
//   G2 はポーリング/イベントで refreshG2 が呼ばれた時に自然に切り替わる。

export type Language = 'en' | 'ja'

const STRINGS = {
  // ─── App ─────────────────────────────────────────────────────
  appName:        { en: 'headlenss',                            ja: 'headlenss' },
  appTagline:     { en: 'Voice control for Claude Code',        ja: '音声で Claude Code を動かす' },

  // ─── Onboarding ──────────────────────────────────────────────
  step1of2:       { en: 'Step 1 / 2',                           ja: 'Step 1 / 2' },
  step2of2:       { en: 'Step 2 / 2',                           ja: 'Step 2 / 2' },
  ob1Title:       { en: 'Connect to your PC',                   ja: 'PC に接続' },
  ob1Desc:        { en: 'Paste the URL of the headlenss server running on your PC (shown in the terminal where you started it, e.g. http://<tailscale-ip>:3000).',
                    ja: 'PC で起動した headlenss server の URL を貼り付けてください。サーバ起動時にターミナルへ表示される URL (例: http://<tailscale-ip>:3000) です。' },
  ob1ProbeIdle:   { en: 'Auto-checks the URL as you type.',     ja: 'URL を入れると自動で確認します' },
  obNext:         { en: 'Next →',                               ja: '次へ →' },
  ob2Title:       { en: 'Speech-to-text key',                   ja: '音声認識キー' },
  ob2Desc:        { en: 'Speechmatics is used to transcribe your voice. Free up to 480 minutes per month.',
                    ja: '音声を文字に変換するために Speechmatics の API key を使います。月480分まで無料です。' },
  ob2GetKey:      { en: 'Get an API key →',                     ja: 'API key を取得 →' },
  obSmKeyPh:      { en: 'Paste API key',                        ja: 'API key を貼り付け' },
  obBack:         { en: '← Back',                               ja: '← 戻る' },
  obFinish:       { en: 'Start',                                ja: 'はじめる' },

  // ─── Top bar ─────────────────────────────────────────────────
  sessionLabel:   { en: '→ session',                            ja: '→ session' },

  // ─── New Claude Session ──────────────────────────────────────
  newClaudeHead:  { en: 'New Claude session',                   ja: '新規 Claude セッション' },
  newClaudeName:  { en: 'Session name',                         ja: 'セッション名' },
  newClaudeCwd:   { en: 'Working directory',                    ja: '作業ディレクトリ' },
  newClaudeStart: { en: 'Start Claude',                         ja: 'Claude を起動' },
  newClaudeNeedName: { en: 'Session name is required.',         ja: 'セッション名を入力してください。' },
  newClaudeStarting: { en: 'Starting…',                         ja: '起動中…' },
  newClaudeOk:    { en: 'Started ✓',                            ja: '起動しました ✓' },
  newClaudeFail:  { en: 'Failed: ',                             ja: '失敗: ' },

  // ─── Sections ────────────────────────────────────────────────
  sessionsHead:   { en: 'Sessions',                             ja: 'Sessions' },
  refresh:        { en: 'refresh',                              ja: 'refresh' },
  newSessionPh:   { en: 'new session name',                     ja: 'new session name' },
  newSessionBtn:  { en: '+ create',                             ja: '+ create' },
  pendingHead:    { en: 'Pending',                              ja: '確定待ち' },
  pendingDiscard: { en: '↓ Discard',                            ja: '↓ 破棄' },
  pendingConfirm: { en: '↑ Send',                               ja: '↑ 送信' },
  outputHead:     { en: 'Output',                               ja: 'Output' },
  noOutput:       { en: '(no output yet)',                      ja: '(no output yet)' },
  recentHead:     { en: 'Recent',                               ja: 'Recent' },
  clear:          { en: 'clear',                                ja: 'clear' },
  noHistory:      { en: '(nothing sent yet)',                   ja: '(まだ送信していません)' },

  // ─── Settings ────────────────────────────────────────────────
  settingsTitle:  { en: '⚙ Settings',                           ja: '⚙ 設定' },
  serverUrl:      { en: 'Server URL',                           ja: 'Server URL' },
  smApiKey:       { en: 'Speechmatics API key',                 ja: 'Speechmatics API key' },
  advanced:       { en: 'Advanced',                             ja: '詳細設定' },
  submitOnSend:   { en: 'Press Enter after sending (auto-execute)',
                    ja: '送信後に Enter を打つ (即実行)' },
  smLang:         { en: 'Language',                             ja: '言語' },
  smOperating:    { en: 'operating_point',                      ja: 'operating_point' },
  resetSetup:     { en: 'Re-run setup',                         ja: 'セットアップをやり直す' },
  unset:          { en: '(unset)',                              ja: '未設定' },
  toastUrlCopied: { en: 'URL copied. Open it in your browser.', ja: 'URL をコピーしました。ブラウザで開いてください。' },
  toastUrlCopyFail:{ en: 'Failed to copy. URL: ',               ja: 'コピーに失敗。URL: ' },
  pickSession:    { en: 'Pick session on G2',                   ja: 'G2 でセッションを選択' },
  recBtn:         { en: 'Record',                               ja: 'Record' },
  recBtnStop:     { en: 'Stop',                                 ja: 'Stop' },
  recBtnPending:  { en: '↑Send / ↓Discard',                    ja: '↑送信 / ↓破棄' },
  finalizing:     { en: 'Finalizing…',                          ja: 'Finalizing…' },
  sending:        { en: 'Sending…',                             ja: 'Sending…' },

  // ─── G2 lens header (現在の phase タイトル) ──────────────────
  g2HeadBoot:         { en: 'Booting',                          ja: '起動中' },
  g2HeadSetup:        { en: 'Setup',                            ja: '初期設定' },
  g2HeadRoot:         { en: 'Sessions',                         ja: 'セッション' },
  g2HeadRecording:    { en: 'Recording',                        ja: '録音中' },
  g2HeadFinalizing:   { en: 'Transcribing',                     ja: '文字起こし中' },
  g2HeadPending:      { en: 'Pending',                          ja: '確認待ち' },
  g2HeadSending:      { en: 'Sending',                          ja: '送信中' },
  g2HeadCcResponse:   { en: 'Claude Prompt',                    ja: 'Claude 応答' },
  g2HeadError:        { en: 'Error',                            ja: 'エラー' },

  // ─── G2 lens ─────────────────────────────────────────────────
  g2Booting:        { en: 'Booting…',                           ja: '起動中…' },
  g2Setup:          { en: 'SETUP MODE',                         ja: '初期設定中' },
  g2SetupHint:      { en: 'Open headlenss app on your phone',   ja: 'スマホで headlenss を設定してください' },
  g2BridgeMissing:  { en: 'G2 bridge not connected',            ja: 'G2 ブリッジ未接続' },
  g2SetUrl:         { en: 'Set Server URL',                     ja: 'Server URL を設定' },
  g2SetKey:         { en: 'Set Speechmatics key',               ja: 'API key を設定' },
  g2Unreachable:    { en: 'Server unreachable',                 ja: 'サーバへ接続できません' },
  g2ConfigureSess:  { en: 'Configure session',                  ja: 'セッションを設定' },
  g2Ready:          { en: 'Ready',                              ja: 'Ready' },
  g2Recording:      { en: 'Recording',                          ja: 'Recording' },
  g2Finalizing:     { en: 'Finalizing…',                        ja: 'Finalizing…' },
  g2PendingHint:    { en: '↑ Send / ↓ Discard',                ja: '↑ 送信 / ↓ 破棄' },
  g2Sending:        { en: 'Sending →',                          ja: 'Sending →' },
  g2NoSessions:     { en: '(no sessions)\nCreate one in app',   ja: '(セッション無し)\nスマホで作成' },
  g2NoSessionsBrief:{ en: 'No session',                         ja: 'セッション無し' },
  g2Sessions:       { en: 'Claude sessions',                    ja: 'Claude セッション' },
  g2ClaudeAck:      { en: 'Claude waiting',                     ja: 'Claude 応答待ち' },
  // G2 footer (28全角文字 = 56半角文字 以内)。各 phase で利用可能な全操作を網羅する。
  // 共通記法: `Click:X ↑↓:Y ⊕⊕:Z` (⊕⊕ = double click)
  g2FootRoot:       { en: 'Click:Open ↑↓:Nav ⊕⊕:Exit',          ja: 'Click:開く ↑↓:移動 ⊕⊕:終了' },
  g2FootRecOff:     { en: 'Click:Done ⊕⊕:Cancel',                ja: 'Click:録音終了 ⊕⊕:取消' },
  g2FootFinalizing: { en: 'Transcribing…',                       ja: '文字起こし中…' },
  g2FootPending:    { en: 'Click:Add ↑:Send ↓:Del ⊕⊕:Back',     ja: 'Click:追加 ↑:送信 ↓:削除 ⊕⊕:戻る' },
  g2FootSending:    { en: 'Sending to tmux…',                    ja: 'tmuxに送信中…' },
  g2FootSetup:      { en: 'Set up on phone',                     ja: 'スマホで設定' },
  g2FootIdle:       { en: 'Click:Rec ↑↓:Scroll ⊕⊕:Back',        ja: 'Click:録音 ↑↓:履歴 ⊕⊕:戻る' },
  g2FootCcResponse: { en: '↑↓:Pick Click:OK ⊕⊕:Cancel',          ja: '↑↓:選択 Click:確定 ⊕⊕:取消' },
  g2NoOutput:       { en: '(no output yet)',                    ja: '(まだ出力なし)' },
} as const

export type StringKey = keyof typeof STRINGS

let currentLanguage: Language = 'ja'
const listeners = new Set<(lang: Language) => void>()

export function getLanguage(): Language {
  return currentLanguage
}

export function setLanguage(lang: Language): void {
  if (currentLanguage === lang) return
  currentLanguage = lang
  for (const fn of listeners) fn(lang)
}

export function onLanguageChange(fn: (lang: Language) => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

export function t(key: StringKey): string {
  return STRINGS[key]?.[currentLanguage] ?? key
}

/** WebView 全体に翻訳を反映する。各要素は data-i18n="key" / data-i18n-placeholder="key" / data-i18n-aria-label="key" を持てる */
export function applyTranslations(root: ParentNode = document): void {
  // textContent
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n]')) {
    const key = el.dataset.i18n as StringKey
    if (!key) continue
    el.textContent = t(key)
  }
  // placeholder
  for (const el of root.querySelectorAll<HTMLInputElement>('[data-i18n-placeholder]')) {
    const key = el.dataset.i18nPlaceholder as StringKey
    if (!key) continue
    el.placeholder = t(key)
  }
  // aria-label
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n-aria-label]')) {
    const key = el.dataset.i18nAriaLabel as StringKey
    if (!key) continue
    el.setAttribute('aria-label', t(key))
  }
  // <html lang>
  document.documentElement.setAttribute('lang', currentLanguage)
}

export const LANGUAGE_LABELS: Record<Language, string> = {
  en: 'English',
  ja: '日本語',
}
