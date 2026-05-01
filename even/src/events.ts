import { OsEventTypeList, type EvenHubEvent } from '@evenrealities/even_hub_sdk'

const SCROLL_COOLDOWN_MS = 200

type Handlers = {
  onScrollUp: () => void
  onScrollDown: () => void
  onClick: () => void
  onDoubleClick: () => void
  onAudio: (pcm: Uint8Array) => void
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

function resolveEventType(event: EvenHubEvent): OsEventTypeList | undefined {
  const raw =
    event.listEvent?.eventType ??
    event.textEvent?.eventType ??
    event.sysEvent?.eventType ??
    ((event.jsonData ?? {}) as Record<string, unknown>).eventType ??
    ((event.jsonData ?? {}) as Record<string, unknown>).event_type ??
    ((event.jsonData ?? {}) as Record<string, unknown>).Event_Type ??
    ((event.jsonData ?? {}) as Record<string, unknown>).type

  if (typeof raw === 'number') {
    switch (raw) {
      case 0: return OsEventTypeList.CLICK_EVENT
      case 1: return OsEventTypeList.SCROLL_TOP_EVENT
      case 2: return OsEventTypeList.SCROLL_BOTTOM_EVENT
      case 3: return OsEventTypeList.DOUBLE_CLICK_EVENT
      default: return undefined
    }
  }

  if (typeof raw === 'string') {
    const v = raw.toUpperCase()
    if (v.includes('DOUBLE')) return OsEventTypeList.DOUBLE_CLICK_EVENT
    if (v.includes('CLICK')) return OsEventTypeList.CLICK_EVENT
    if (v.includes('SCROLL_TOP') || v.includes('UP')) return OsEventTypeList.SCROLL_TOP_EVENT
    if (v.includes('SCROLL_BOTTOM') || v.includes('DOWN')) return OsEventTypeList.SCROLL_BOTTOM_EVENT
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
    default:
      handlers.onLog?.(`UNHANDLED: ${String(eventType)} | ${JSON.stringify(event)}`)
      break
  }
}
