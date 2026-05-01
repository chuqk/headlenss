import {
  CreateStartUpPageContainer,
  RebuildPageContainer,
  TextContainerProperty,
  TextContainerUpgrade,
} from '@evenrealities/even_hub_sdk'
import type { EvenAppBridge } from '@evenrealities/even_hub_sdk'

const DISPLAY_WIDTH = 576
const DISPLAY_HEIGHT = 288
const FOOTER_HEIGHT = 40
const CONTENT_HEIGHT = DISPLAY_HEIGHT - FOOTER_HEIGHT

let bridge: EvenAppBridge | null = null
let startupRendered = false

export function initRenderer(appBridge: EvenAppBridge): void {
  bridge = appBridge
}

async function rebuildPage(config: {
  containerTotalNum: number
  textObject?: TextContainerProperty[]
}): Promise<void> {
  if (!bridge) return
  if (!startupRendered) {
    await bridge.createStartUpPageContainer(new CreateStartUpPageContainer(config))
    startupRendered = true
    return
  }
  await bridge.rebuildPageContainer(new RebuildPageContainer(config))
}

function evtContainer(): TextContainerProperty {
  return new TextContainerProperty({
    containerID: 1,
    containerName: 'evt',
    content: ' ',
    xPosition: 0,
    yPosition: 0,
    width: DISPLAY_WIDTH,
    height: DISPLAY_HEIGHT,
    isEventCapture: 1,
    paddingLength: 0,
  })
}

function footerContainer(footer: string): TextContainerProperty {
  return new TextContainerProperty({
    containerID: 3,
    containerName: 'footer',
    content: footer,
    xPosition: 0,
    yPosition: CONTENT_HEIGHT,
    width: DISPLAY_WIDTH,
    height: FOOTER_HEIGHT,
    isEventCapture: 0,
    paddingLength: 4,
  })
}

export async function showScreen(content: string, footer: string): Promise<void> {
  await rebuildPage({
    containerTotalNum: 3,
    textObject: [
      evtContainer(),
      new TextContainerProperty({
        containerID: 2,
        containerName: 'main',
        content,
        xPosition: 0,
        yPosition: 0,
        width: DISPLAY_WIDTH,
        height: CONTENT_HEIGHT,
        isEventCapture: 0,
        paddingLength: 4,
        borderWidth: 1,
        borderColor: 13,
        borderRadius: 0,
      }),
      footerContainer(footer),
    ],
  })
}

export async function updateContent(content: string): Promise<void> {
  if (!bridge) return
  await bridge.textContainerUpgrade(
    new TextContainerUpgrade({
      containerID: 2,
      containerName: 'main',
      contentOffset: 0,
      contentLength: 2000,
      content,
    }),
  )
}

export async function updateFooter(footer: string): Promise<void> {
  if (!bridge) return
  await bridge.textContainerUpgrade(
    new TextContainerUpgrade({
      containerID: 3,
      containerName: 'footer',
      contentOffset: 0,
      contentLength: 2000,
      content: footer,
    }),
  )
}
