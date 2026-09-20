import {
  CameraEventType,
  Cartesian3,
  KeyboardEventModifier,
} from 'cesium'
import type { Viewer as CesiumViewer } from 'cesium'

const trackpadOrbitAxisRatio = 1.15
const trackpadOrbitPixelToRadian = 0.0024
const lineDeltaToPixels = 16
const pageDeltaToPixels = 120
const orbitAxisScratch = new Cartesian3()

export const globeRotateEventTypes = CameraEventType.LEFT_DRAG

export const globeZoomEventTypes = [
  CameraEventType.WHEEL,
  { eventType: CameraEventType.WHEEL, modifier: KeyboardEventModifier.CTRL },
  CameraEventType.PINCH,
]

export const globeTiltEventTypes = [
  CameraEventType.MIDDLE_DRAG,
  CameraEventType.RIGHT_DRAG,
  CameraEventType.PINCH,
  { eventType: CameraEventType.LEFT_DRAG, modifier: KeyboardEventModifier.CTRL },
  { eventType: CameraEventType.LEFT_DRAG, modifier: KeyboardEventModifier.ALT },
  { eventType: CameraEventType.WHEEL, modifier: KeyboardEventModifier.ALT },
]

// 必须是数组：resium 的 ScreenSpaceCameraController.lookEventTypes 只接受
// any[] | CameraEventType | undefined，裸的 { eventType, modifier } 对象过不了 tsc。
// Cesium 运行时两种写法等价，所以包一层数组不改变行为。
export const globeLookEventTypes = [
  { eventType: CameraEventType.LEFT_DRAG, modifier: KeyboardEventModifier.SHIFT },
]

const wheelDeltaToPixels = (delta: number, deltaMode: number) => {
  if (deltaMode === WheelEvent.DOM_DELTA_LINE) return delta * lineDeltaToPixels
  if (deltaMode === WheelEvent.DOM_DELTA_PAGE) return delta * pageDeltaToPixels
  return delta
}

export const bindTrackpadOrbit = (
  canvas: HTMLCanvasElement,
  getViewer: () => CesiumViewer | undefined,
) => {
  const onWheel = (event: WheelEvent) => {
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return
    if (Math.abs(event.deltaX) <= Math.abs(event.deltaY) * trackpadOrbitAxisRatio) return

    const viewer = getViewer()
    if (!viewer || viewer.isDestroyed()) return

    event.preventDefault()
    event.stopImmediatePropagation()

    Cartesian3.clone(viewer.camera.up, orbitAxisScratch)
    viewer.camera.rotate(
      orbitAxisScratch,
      wheelDeltaToPixels(event.deltaX, event.deltaMode) * trackpadOrbitPixelToRadian,
    )
  }

  canvas.addEventListener('wheel', onWheel, { capture: true, passive: false })
  return () => canvas.removeEventListener('wheel', onWheel, { capture: true })
}
