import { useEffect, useRef } from 'react'
import {
  isCameraAligned,
  requestOrientationReset,
  subscribeCameraAttitude,
  wrapHeadingDegrees,
} from '../data/cameraOrientation'
import './compass.css'

export function CompassButton() {
  const buttonRef = useRef<HTMLButtonElement>(null)
  const roseRef = useRef<SVGGElement>(null)

  useEffect(() => subscribeCameraAttitude((attitude) => {
    const heading = wrapHeadingDegrees(attitude.headingDeg)
    const aligned = isCameraAligned(attitude)
    roseRef.current?.setAttribute('transform', `rotate(${-heading} 16 16)`)

    const button = buttonRef.current
    if (!button) return

    button.dataset.aligned = aligned ? 'true' : 'false'
    button.setAttribute('aria-label', aligned ? '地图已正北' : '回正地图')
    button.title = aligned ? '地图已正北' : '回正地图（正北）'
  }), [])

  return (
    <button
      ref={buttonRef}
      type="button"
      className="atlas-dock-button atlas-compass-button pointer-events-auto"
      aria-label="回正地图"
      title="回正地图（正北）"
      data-aligned="true"
      onClick={requestOrientationReset}
    >
      <svg viewBox="0 0 32 32" aria-hidden="true" className="atlas-compass-icon">
        <circle className="atlas-compass-ring" cx="16" cy="16" r="11.2" />
        <g ref={roseRef}>
          <path className="atlas-compass-south" d="M16 26.2 13.15 16 16 13.4 18.85 16Z" />
          <path className="atlas-compass-north" d="M16 5.8 18.85 16 16 18.6 13.15 16Z" />
          <text className="atlas-compass-label" x="16" y="9.2" textAnchor="middle">N</text>
        </g>
      </svg>
    </button>
  )
}
