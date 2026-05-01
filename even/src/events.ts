import { OsEventTypeList, type EvenHubEvent } from '@evenrealities/even_hub_sdk'

const SCROLL_COOLDOWN_MS = 200

type Handlers = {
  onScrollUp: () => void
  onScrollDown: () => void
  onClick: () => void
  onDoubleClick: () => void
  onAudio: (pcm: Uint8Array) => void
  onForegroundEnter?: () => void
  onForegroundExit?: () => void
  onLog?: (msg: string) => void
}

let handlers: Handlers = {
  onScrollUp: () => {},
  onScrollDown: () => {},
  onClick: () => {},
  onDoubleClick: () => {},
  onAudio: () => {},
}

export function setEventHandlers(h: Handlers): void {
  handlers = h
}

let lastScrollTime = 0

function scrollThrottled(): boolean {
  const now = Date.now()
  if (now - lastScrollTime < SCROLL_COOLDOWN_MS) return true
  lastScrollTime = now
  return false
}

/**
 * EvenHubEvent の eventType を OsEventTypeList に正規化。
 * SDK が用意している `OsEventTypeList.fromJson` を最優先で使う (0..8 を網羅)。
 */
function resolveEventType(event: EvenHubEvent): OsEventTypeList | undefined {
  const raw =
    event.listEvent?.eventType ??
    event.textEvent?.eventType ??
    event.sysEvent?.eventType ??
    ((event.jsonData ?? {}) as Record<string, unknown>).eventType ??
    ((event.jsonData ?? {}) as Record<string, unknown>).event_type ??
    ((event.jsonData ?? {}) as Record<string, unknown>).Event_Type ??
    ((event.jsonData ?? {}) as Record<string, unknown>).type

  const fromSdk = OsEventTypeList.fromJson?.(raw)
  if (fromSdk !== undefined) return fromSdk

  // フォールバック (SDK 古い場合)
  if (typeof raw === 'number') {
    if (raw >= 0 && raw <= 8) return raw as OsEventTypeList
  }
  if (event.listEvent || event.textEvent || event.sysEvent) return OsEventTypeList.CLICK_EVENT
  return undefined
}

export function onEvenHubEvent(event: EvenHubEvent): void {
  if (event.audioEvent?.audioPcm) {
    handlers.onAudio(new Uint8Array(event.audioEvent.audioPcm))
    return
  }

  const eventType = resolveEventType(event)
  switch (eventType) {
    case OsEventTypeList.SCROLL_TOP_EVENT:
      if (!scrollThrottled()) handlers.onScrollUp()
      break
    case OsEventTypeList.SCROLL_BOTTOM_EVENT:
      if (!scrollThrottled()) handlers.onScrollDown()
      break
    case OsEventTypeList.CLICK_EVENT:
      handlers.onClick()
      break
    case OsEventTypeList.DOUBLE_CLICK_EVENT:
      handlers.onDoubleClick()
      break
    case OsEventTypeList.FOREGROUND_ENTER_EVENT:
      handlers.onForegroundEnter?.()
      break
    case OsEventTypeList.FOREGROUND_EXIT_EVENT:
      handlers.onForegroundExit?.()
      break
    case OsEventTypeList.ABNORMAL_EXIT_EVENT:
    case OsEventTypeList.SYSTEM_EXIT_EVENT:
    case OsEventTypeList.IMU_DATA_REPORT:
      // 黙殺
      break
    default:
      handlers.onLog?.(`UNHANDLED: ${String(eventType)} | ${JSON.stringify(event)}`)
      break
  }
}
