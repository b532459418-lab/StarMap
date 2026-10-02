import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  isCameraAligned,
  requestOrientationReset,
  subscribeCameraAttitude,
  wrapHeadingDegrees,
} from '../data/cameraOrientation'
import './compass.css'

export function CompassButton() {
  const { t } = useTranslation('appShell')
  const [aligned, setAligned] = useState(true)
  const roseRef = useRef<SVGGElement>(null)

  useEffect(() => subscribeCameraAttitude((attitude) => {
    const heading = wrapHeadingDegrees(attitude.headingDeg)
    roseRef.current?.setAttribute('transform', `rotate(${-heading} 16 16)`)
    setAligned(isCameraAligned(attitude))
  }), [])

  return (
    <button
      type="button"
      className="atlas-dock-button atlas-compass-button pointer-events-auto"
      aria-label={t(aligned ? 'northAligned' : 'resetOrientation')}
      title={t(aligned ? 'northAligned' : 'resetOrientationHint')}
      data-aligned={aligned ? 'true' : 'false'}
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
