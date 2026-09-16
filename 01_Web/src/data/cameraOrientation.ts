export type CameraAttitude = {
  defaultPitchDeg: number
  headingDeg: number
  pitchDeg: number
  rollDeg: number
}

type AttitudeListener = (attitude: CameraAttitude) => void

const headingAlignDegrees = 6
const pitchAlignDegrees = 8
const rollAlignDegrees = 6

const attitudeListeners = new Set<AttitudeListener>()
let orientationResetHandler: (() => void) | undefined

export const wrapHeadingDegrees = (degrees: number) => (
  ((degrees + 180) % 360 + 360) % 360 - 180
)

export const isCameraAligned = (attitude: CameraAttitude) => (
  Math.abs(wrapHeadingDegrees(attitude.headingDeg)) <= headingAlignDegrees
  && Math.abs(wrapHeadingDegrees(attitude.rollDeg)) <= rollAlignDegrees
  && Math.abs(attitude.pitchDeg - attitude.defaultPitchDeg) <= pitchAlignDegrees
)

export const publishCameraAttitude = (attitude: CameraAttitude) => {
  attitudeListeners.forEach((listener) => listener(attitude))
}

export const subscribeCameraAttitude = (listener: AttitudeListener) => {
  attitudeListeners.add(listener)
  return () => {
    attitudeListeners.delete(listener)
  }
}

export const registerOrientationResetHandler = (handler: () => void) => {
  orientationResetHandler = handler
  return () => {
    if (orientationResetHandler === handler) {
      orientationResetHandler = undefined
    }
  }
}

export const requestOrientationReset = () => {
  orientationResetHandler?.()
}
