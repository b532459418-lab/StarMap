import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArcType,
  BoundingSphere,
  Cartesian2,
  Cartesian3,
  Cartographic,
  Color,
  EllipsoidGeodesic,
  HeadingPitchRange,
  LabelStyle,
  Math as CesiumMath,
  Matrix4,
  PolylineOutlineMaterialProperty,
  SceneTransforms,
  Viewer as CesiumViewer,
} from 'cesium'
import {
  Entity,
  Globe as CesiumGlobe,
  ImageryLayer,
  Scene,
  ScreenSpaceCameraController,
  SkyBox as CesiumSkyBox,
  SkyAtmosphere,
  Sun as CesiumSun,
  Viewer,
} from 'resium'
import type { CesiumComponentRef } from 'resium'
import { droneMediaById, droneMediaItems } from '../data/droneMedia'
import type { DroneMediaItem } from '../data/droneMedia'
import { GooglePhotorealisticTiles } from '../extensions/GooglePhotorealisticTiles'
import { createMapSourceLayers } from '../extensions/mapSources'
import type { MapSourceId } from '../extensions/mapSources'
import { publishCameraAttitude, registerOrientationResetHandler, wrapHeadingDegrees } from '../data/cameraOrientation'
// 可渲染集合改由 layerData prop 提供（PR3 / FR-MR-1）。这里只剩下【选中项与相机】要用的查表：
// selectedCountry / selectedCity / overviewTarget，FR-MR-3 明确相机不随图层开关改变。
import { cityById, countryById, travelAtlasDisplay } from '../data/travelAtlas'
import type { CityId, CountryId, SelectionMode } from '../types/travel'
import { officialLayers, TRAVEL_LAYER_ID, WANT_TO_GO_LAYER_ID } from '../worldgraph/layers'
import type { LayerPlace, LayerQueryResult } from '../worldgraph/query'
import type { EntityId } from '../worldgraph/types'
import { CesiumConstellationSky } from './CesiumConstellationSky'
import {
  bindTrackpadOrbit,
  globeLookEventTypes,
  globeRotateEventTypes,
  globeTiltEventTypes,
  globeZoomEventTypes,
} from './cameraInput'
import 'cesium/Build/Cesium/Widgets/widgets.css'

const maxCesiumDevicePixelRatio = 2

type CesiumAtlasGlobeProps = {
  hoveredCountryId?: CountryId
  imageryBrightness: number
  imageryContrast: number
  imagerySaturation: number
  mapSource: MapSourceId
  showCity3DTiles?: boolean
  showLabelsOverlay?: boolean
  selectedCountryId?: CountryId
  selectedCityId?: CityId
  selectionMode: SelectionMode
  globeScale: number
  resetVersion: number
  isNight: boolean
  showMapContent?: boolean
  /**
   * 可见图层查询结果（PRD v0.4 FR-MR-1）。城市标记与路线【只】来自这里；
   * 图层被关掉时它自然为空，Entity 不再渲染。底图、相机与媒体标记不受它影响。
   */
  layerData: LayerQueryResult
  activeDroneMediaCityId?: CityId
  activeDroneMediaItemId?: string
  onSelectCity: (cityId: CityId) => void
  /**
   * 点击【纯想去】地点（不含足迹）时调用（FR-WTG-4）：只打开详情卡，
   * 不改 selectionMode、不飞相机。含足迹的地点仍走 onSelectCity。
   */
  onSelectWantToGoPlace?: (entityId: EntityId) => void
  onSelectDroneMediaItem: (item: DroneMediaItem) => void
  /**
   * Collection 页「在地图上查看」要求镜头飞到的地点（PR7）。优先级低于无人机、高于城市 / 国家；
   * 飞行方式与城市焦点完全相同，只是目标坐标不同。requestId 每次「在地图上查看」都递增，
   * 同一地点再点一次也会重新飞过去。
   */
  focusPlace?: { entityId: EntityId; lat: number; lng: number; requestId: number }
}

type CursorTrailPoint = {
  x: number
  y: number
  time: number
  speed: number
}

const cursorTrailMaxAgeMs = 680
const cursorTrailMaxLength = 620
const cursorTrailMaxPoints = 96
const cursorTrailFadeDelayMs = 52
const cursorTrailFadeDurationMs = 320

const clamp01 = (value: number) => Math.min(1, Math.max(0, value))

const trimCursorTrailPoints = (points: CursorTrailPoint[], now: number) => {
  if (points.length < 2) return points

  let startIndex = points.length - 1
  let accumulatedLength = 0

  for (let index = points.length - 1; index > 0; index -= 1) {
    const current = points[index]
    const previous = points[index - 1]
    const segmentLength = Math.hypot(current.x - previous.x, current.y - previous.y)

    if (
      now - previous.time > cursorTrailMaxAgeMs
      || accumulatedLength + segmentLength > cursorTrailMaxLength
    ) {
      break
    }

    accumulatedLength += segmentLength
    startIndex = index - 1
  }

  return points.slice(startIndex)
}

const smoothCursorTrailPoints = (points: CursorTrailPoint[]) => {
  if (points.length < 3) return points

  const smoothed: CursorTrailPoint[] = []
  const samplesPerSegment = 4

  for (let index = 0; index < points.length - 1; index += 1) {
    const point0 = points[Math.max(0, index - 1)]
    const point1 = points[index]
    const point2 = points[index + 1]
    const point3 = points[Math.min(points.length - 1, index + 2)]

    for (let sample = 0; sample < samplesPerSegment; sample += 1) {
      const progress = sample / samplesPerSegment
      const progressSquared = progress * progress
      const progressCubed = progressSquared * progress
      const interpolate = (a: number, b: number, c: number, d: number) => 0.5 * (
        (2 * b)
        + (-a + c) * progress
        + (2 * a - 5 * b + 4 * c - d) * progressSquared
        + (-a + 3 * b - 3 * c + d) * progressCubed
      )

      smoothed.push({
        x: interpolate(point0.x, point1.x, point2.x, point3.x),
        y: interpolate(point0.y, point1.y, point2.y, point3.y),
        time: point1.time + (point2.time - point1.time) * progress,
        speed: point1.speed + (point2.speed - point1.speed) * progress,
      })
    }
  }

  smoothed.push(points[points.length - 1])
  return smoothed
}

const overviewTarget = travelAtlasDisplay.overviewTarget

const cityMarkerHeight = 600

const cityPosition = (lng: number, lat: number) =>
  Cartesian3.fromDegrees(lng, lat, cityMarkerHeight)

type PositionedDroneMediaItem = DroneMediaItem & {
  position: NonNullable<DroneMediaItem['position']>
}

const hasDronePosition = (item: DroneMediaItem): item is PositionedDroneMediaItem => Boolean(item.position)

const droneMediaPosition = (item: PositionedDroneMediaItem) =>
  Cartesian3.fromDegrees(
    item.position.lng,
    item.position.lat,
    (item.position.altitudeMeters ?? 0) + 45,
  )

const dronePinImage = `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <defs>
    <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur stdDeviation="3" result="blur"/>
      <feMerge>
        <feMergeNode in="blur"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>
  </defs>
  <circle cx="32" cy="32" r="22" fill="#0ea5e9" fill-opacity="0.9" filter="url(#glow)"/>
  <circle cx="32" cy="32" r="17" fill="#020617" fill-opacity="0.78"/>
  <path d="M17 27h10l3-8h4l3 8h10v5H36l-3 9h-2l-3-9H17z" fill="#e0f2fe"/>
  <circle cx="18" cy="29.5" r="3" fill="#7dd3fc"/>
  <circle cx="46" cy="29.5" r="3" fill="#7dd3fc"/>
  <circle cx="32" cy="20" r="3" fill="#7dd3fc"/>
  <circle cx="32" cy="42" r="3" fill="#7dd3fc"/>
</svg>
`)}`

const cityHoverMarkerImageCache = new Map<string, string>()

const cityHoverMarkerImage = (accent: string, corePixelSize: number) => {
  const cacheKey = `${accent}:${corePixelSize}`
  const cachedImage = cityHoverMarkerImageCache.get(cacheKey)
  if (cachedImage) return cachedImage

  const markerPixelSize = 38
  const coreRadius = corePixelSize * 32 / markerPixelSize
  const outlineWidth = 2 * 64 / markerPixelSize
  const image = `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(`
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
      <defs>
        <radialGradient id="city-glow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stop-color="${accent}" stop-opacity="0.62"/>
          <stop offset="24%" stop-color="${accent}" stop-opacity="0.44"/>
          <stop offset="58%" stop-color="${accent}" stop-opacity="0.16"/>
          <stop offset="100%" stop-color="${accent}" stop-opacity="0"/>
        </radialGradient>
      </defs>
      <circle cx="32" cy="32" r="31" fill="url(#city-glow)"/>
      <circle
        cx="32"
        cy="32"
        r="${coreRadius}"
        fill="${accent}"
        stroke="#ffffff"
        stroke-opacity="0.94"
        stroke-width="${outlineWidth}"
      />
    </svg>
  `)}`

  cityHoverMarkerImageCache.set(cacheKey, image)
  return image
}

/** 想去标记的主色来自 Layer Registry（PRD §9.3 / Q1），不在组件里另写一份。 */
const wantToGoAccent = officialLayers.find((layer) => layer.id === WANT_TO_GO_LAYER_ID)?.accent ?? '#F0647A'

const wantToGoBadgeImageCache = new Map<string, string>()

/**
 * FR-MR-5 的心形徽标：足迹 + 想去同一地点时叠在足迹标记右上角。
 * 生成与缓存方式同 cityHoverMarkerImage（SVG data URI + 按颜色缓存），
 * 白色细描边让它在任何国家配色的足迹标记旁都看得清。
 */
const wantToGoBadgeImage = (accent: string) => {
  const cachedImage = wantToGoBadgeImageCache.get(accent)
  if (cachedImage) return cachedImage

  const image = `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(`
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
      <path
        d="M16 28.2C16 28.2 3.2 20.3 3.2 11.6C3.2 7.4 6.4 4.2 10.4 4.2C12.8 4.2 14.8 5.5 16 7.5C17.2 5.5 19.2 4.2 21.6 4.2C25.6 4.2 28.8 7.4 28.8 11.6C28.8 20.3 16 28.2 16 28.2Z"
        fill="${accent}"
        stroke="#ffffff"
        stroke-opacity="0.94"
        stroke-width="2.6"
        stroke-linejoin="round"
      />
    </svg>
  `)}`

  wantToGoBadgeImageCache.set(accent, image)
  return image
}

type CameraScale = 'world' | 'country' | 'city' | 'droneGroup' | 'drone'

const maximumZoomDistance = 22_000_000

const cameraScaleStates: Record<
  CameraScale,
  { rangeOrHeight: number; pitch: number; duration: number }
> = {
  world: { rangeOrHeight: maximumZoomDistance, pitch: -90, duration: 1.2 },
  country: { rangeOrHeight: 3_100_000, pitch: -62, duration: 1.3 },
  city: { rangeOrHeight: 680_000, pitch: -48, duration: 1.35 },
  droneGroup: { rangeOrHeight: 20_000, pitch: -42, duration: 1.15 },
  drone: { rangeOrHeight: 9_000, pitch: -42, duration: 1 },
}

const cameraScaleForGlobeScale = (scale: number): CameraScale => {
  if (scale < 1.68) return 'city'
  if (scale < 2.55) return 'country'
  return 'world'
}

const viewCenterScratch = new Cartesian2()

const pickViewTarget = (viewer: CesiumViewer) => {
  const canvas = viewer.scene.canvas
  viewCenterScratch.x = canvas.clientWidth / 2
  viewCenterScratch.y = canvas.clientHeight / 2
  const ray = viewer.camera.getPickRay(viewCenterScratch)
  if (ray) {
    const globeHit = viewer.scene.globe.pick(ray, viewer.scene)
    if (globeHit) return globeHit
  }
  if (viewer.scene.pickPositionSupported) {
    return viewer.scene.pickPosition(viewCenterScratch)
  }
  return undefined
}

const orientationResetDuration = () => (
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ? 0
    : 0.72
)

const createRoutePositions = (
  startLng: number,
  startLat: number,
  endLng: number,
  endLat: number,
  routeType: string,
) => {
  const start = Cartographic.fromDegrees(startLng, startLat)
  const end = Cartographic.fromDegrees(endLng, endLat)
  const geodesic = new EllipsoidGeodesic(start, end)
  const routeHeight =
    routeType === 'flight' ? 24_000 : routeType === 'ferry' ? 8_000 : 6_000
  const segmentCount = Math.min(
    96,
    Math.max(32, Math.ceil(geodesic.surfaceDistance / 150_000)),
  )

  return Array.from({ length: segmentCount + 1 }, (_, index) => {
    if (index === 0) return cityPosition(startLng, startLat)
    if (index === segmentCount) return cityPosition(endLng, endLat)

    const fraction = index / segmentCount
    const point = geodesic.interpolateUsingFraction(fraction)
    const height = cityMarkerHeight + Math.sin(Math.PI * fraction) * (routeHeight - cityMarkerHeight)
    return Cartesian3.fromRadians(point.longitude, point.latitude, height)
  })
}

const isPositionFacingCamera = (
  position: Cartesian3,
  cameraPosition: Cartesian3,
) => {
  const surfaceNormal = Cartesian3.normalize(position, new Cartesian3())
  const cameraVector = Cartesian3.subtract(cameraPosition, position, new Cartesian3())

  return Cartesian3.dot(surfaceNormal, cameraVector) > -80_000
}

const setsMatch = <T,>(left: Set<T> | null, right: Set<T>) =>
  left !== null &&
  left.size === right.size &&
  [...right].every((item) => left.has(item))

const configureViewer = (viewer: CesiumViewer) => {
  const devicePixelRatio = Math.max(1, window.devicePixelRatio || 1)
  viewer.resolutionScale = Math.min(
    1,
    maxCesiumDevicePixelRatio / devicePixelRatio,
  )
  viewer.scene.screenSpaceCameraController.minimumZoomDistance = 120
  viewer.scene.screenSpaceCameraController.maximumZoomDistance = maximumZoomDistance
  viewer.scene.globe.depthTestAgainstTerrain = true
  viewer.scene.minimumDisableDepthTestDistance = 0
  viewer.camera.percentageChanged = 0.01
  viewer.forceResize()
}

const debugCameraFocus = (
  source: string,
  details: Record<string, unknown>,
) => {
  if (!import.meta.env.DEV) return

  console.debug('[camera-focus]', JSON.stringify({
    source,
    time: Date.now(),
    ...details,
  }))
}

const debugCesiumGlobeScaleProp = (details: Record<string, unknown>) => {
  if (!import.meta.env.DEV) return

  console.debug('[cesium-globe-scale-prop]', JSON.stringify({
    time: Date.now(),
    ...details,
  }))
}

const debugCameraState = (details: Record<string, unknown>) => {
  if (!import.meta.env.DEV) return

  console.debug('[camera-state]', JSON.stringify({
    time: Date.now(),
    ...details,
  }))
}

const debugCameraCommand = (
  commandNumber: number,
  details: Record<string, unknown>,
) => {
  if (!import.meta.env.DEV) return

  console.debug('[camera-command]', JSON.stringify({
    commandNumber,
    time: Date.now(),
    ...details,
  }))
}

const debugCameraBlockedByDroneLock = (details: Record<string, unknown>) => {
  if (!import.meta.env.DEV) return

  console.debug('[camera-blocked-by-drone-lock]', JSON.stringify({
    time: Date.now(),
    ...details,
  }))
}

type CameraFocus =
  | { type: 'droneItem'; id: string; item: PositionedDroneMediaItem }
  | { type: 'droneGroup'; id?: CityId; items: PositionedDroneMediaItem[] }
  | { type: 'place'; id: EntityId; lat: number; lng: number; requestId: number }
  | { type: 'city'; id?: CityId; lat: number; lng: number }
  | { type: 'country'; id?: CountryId; lat: number; lng: number }
  | { type: 'overview'; id: 'overview'; lat: number; lng: number }

type CameraCommandSource =
  | 'debug-direct-drone'
  | 'drone-item'
  | 'drone-group'
  | 'place'
  | 'city'
  | 'country'
  | 'overview'
  | 'orientation-reset'

type CameraCommandRequest = {
  details: Record<string, unknown>
  reason: string
  run: (viewer: CesiumViewer) => void
  source: CameraCommandSource
}

type ExecuteCameraCommand = (request: CameraCommandRequest) => boolean

const droneLockAllowedCameraSources = new Set<CameraCommandSource>([
  'debug-direct-drone',
  'drone-item',
  'drone-group',
  'orientation-reset',
])

type TravelAtlasDebugCamera = {
  getCameraPose: () => {
    height: number
    heading: number
    lat: number
    lng: number
    pitch: number
    roll: number
  }
  flyToDroneItem: (itemId: string, testHeight?: number) => void
}

declare global {
  interface Window {
    __travelAtlasDebugCamera?: TravelAtlasDebugCamera
  }
}

const installDebugCameraApi = (
  viewer: CesiumViewer,
  executeCameraCommand: ExecuteCameraCommand,
  activateDebugDroneCameraLock: () => void,
) => {
  if (import.meta.env.PROD) return undefined

  const logCameraAfter = (item: DroneMediaItem) => {
    const { positionCartographic } = viewer.camera
    const surfaceNormal = Cartesian3.normalize(viewer.camera.positionWC, new Cartesian3())
    const directionDotSurfaceNormal = Cartesian3.dot(
      viewer.camera.directionWC,
      surfaceNormal,
    )

    console.debug('[debug-direct-drone-camera-after]', JSON.stringify({
      itemId: item.id,
      actualCameraHeight: positionCartographic.height,
      actualCameraLng: CesiumMath.toDegrees(positionCartographic.longitude),
      actualCameraLat: CesiumMath.toDegrees(positionCartographic.latitude),
      actualHeading: CesiumMath.toDegrees(viewer.camera.heading),
      actualPitch: CesiumMath.toDegrees(viewer.camera.pitch),
      actualRoll: CesiumMath.toDegrees(viewer.camera.roll),
      directionDotSurfaceNormal,
      time: Date.now(),
    }))
  }

  const flyToDroneItem = (itemId: string, testHeight: number) => {
    const item = droneMediaById[itemId]

    if (!item || !hasDronePosition(item)) {
      console.warn('[debug-direct-drone-camera-command]', JSON.stringify({
        itemId,
        error: item ? 'Drone media item has no coordinates' : 'Drone media item not found',
        time: Date.now(),
      }))
      return
    }

    activateDebugDroneCameraLock()
    executeCameraCommand({
      source: 'debug-direct-drone',
      reason: 'dev direct drone camera test',
      details: {
        itemId: item.id,
        fileName: item.fileName,
        lat: item.position.lat,
        lng: item.position.lng,
        altitudeMeters: item.position.altitudeMeters,
        testHeight,
        destination: 'cartesian-height',
        rangeOrHeight: testHeight,
      },
      run: (currentViewer) => {
        currentViewer.camera.flyTo({
          destination: Cartesian3.fromDegrees(
            item.position.lng,
            item.position.lat,
            testHeight,
          ),
          duration: 0.8,
          orientation: {
            heading: 0,
            pitch: CesiumMath.toRadians(-55),
            roll: 0,
          },
          complete: () => logCameraAfter(item),
        })
      },
    })
  }

  const debugCamera: TravelAtlasDebugCamera = {
    getCameraPose: () => {
      const { positionCartographic } = viewer.camera

      return {
        height: positionCartographic.height,
        heading: CesiumMath.toDegrees(viewer.camera.heading),
        lat: CesiumMath.toDegrees(positionCartographic.latitude),
        lng: CesiumMath.toDegrees(positionCartographic.longitude),
        pitch: CesiumMath.toDegrees(viewer.camera.pitch),
        roll: CesiumMath.toDegrees(viewer.camera.roll),
      }
    },
    flyToDroneItem: (itemId, testHeight = 1_200) => flyToDroneItem(itemId, testHeight),
  }

  window.__travelAtlasDebugCamera = debugCamera
  console.debug('[debug-direct-drone-camera-ready]', JSON.stringify({
    methods: Object.keys(debugCamera),
    time: Date.now(),
  }))
  return debugCamera
}

export function CesiumAtlasGlobe({
  hoveredCountryId,
  imageryBrightness,
  imageryContrast,
  imagerySaturation,
  mapSource,
  showCity3DTiles = false,
  showLabelsOverlay = true,
  selectedCountryId,
  selectedCityId,
  selectionMode,
  globeScale,
  resetVersion,
  isNight,
  showMapContent = true,
  layerData,
  activeDroneMediaCityId,
  activeDroneMediaItemId,
  onSelectCity,
  onSelectWantToGoPlace,
  onSelectDroneMediaItem,
  focusPlace,
}: CesiumAtlasGlobeProps) {
  const viewerRef = useRef<CesiumComponentRef<CesiumViewer>>(null)
  const globeShellRef = useRef<HTMLDivElement>(null)
  const cursorGlowRef = useRef<HTMLDivElement>(null)
  const cursorTrailRef = useRef<HTMLCanvasElement>(null)
  const cursorTrailPointsRef = useRef<CursorTrailPoint[]>([])
  const cursorTrailFrameRef = useRef<number | null>(null)
  const cursorTrailDrawRef = useRef<(now: number) => void>(() => undefined)
  const cursorTrailReducedMotionRef = useRef(false)
  const cursorTrailNeedsResetRef = useRef(true)
  const lastCursorPointRef = useRef<{ x: number; y: number; time: number } | null>(null)
  const lastCameraFocusKeyRef = useRef<string | undefined>(undefined)
  const worldCenterLockSuspendedRef = useRef(false)
  const cameraCommandCountRef = useRef(0)
  const debugDroneCameraLockUntilRef = useRef(0)
  const [viewerReadyVersion, setViewerReadyVersion] = useState(0)
  const updateVisibleHemisphereRef = useRef<() => void>(() => undefined)
  const [focusOffset, setFocusOffset] = useState({ x: 0, y: 0 })
  const [visibleCityIds, setVisibleCityIds] = useState<Set<CityId> | null>(null)
  const [visibleRouteIds, setVisibleRouteIds] = useState<Set<string> | null>(null)
  const selectedCountry = selectedCountryId ? countryById[selectedCountryId] : undefined
  const selectedCity = selectedCityId ? cityById[selectedCityId] : undefined
  const selectedAccent = selectedCountry?.accent ?? '#38bdf8'
  const mapSourceLayers = useMemo(() => createMapSourceLayers(mapSource), [mapSource])

  const drawCursorTrail = useCallback((now: number) => {
    const canvas = cursorTrailRef.current
    if (!canvas || cursorTrailReducedMotionRef.current) {
      cursorTrailFrameRef.current = null
      return
    }

    const context = canvas.getContext('2d')
    if (!context) {
      cursorTrailFrameRef.current = null
      return
    }

    const cssWidth = canvas.clientWidth
    const cssHeight = canvas.clientHeight
    const pixelRatio = Math.min(2, Math.max(1, window.devicePixelRatio || 1))
    const targetWidth = Math.round(cssWidth * pixelRatio)
    const targetHeight = Math.round(cssHeight * pixelRatio)

    if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
      canvas.width = targetWidth
      canvas.height = targetHeight
    }

    context.setTransform(1, 0, 0, 1, 0, 0)
    context.clearRect(0, 0, canvas.width, canvas.height)
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)

    const trimmedPoints = trimCursorTrailPoints(cursorTrailPointsRef.current, now)
    cursorTrailPointsRef.current = trimmedPoints
    const latestPoint = trimmedPoints[trimmedPoints.length - 1]

    if (!latestPoint || trimmedPoints.length < 2) {
      cursorTrailFrameRef.current = null
      return
    }

    const idleTime = now - latestPoint.time
    const idleFade = clamp01(
      1 - Math.max(0, idleTime - cursorTrailFadeDelayMs) / cursorTrailFadeDurationMs,
    )

    if (idleFade <= 0) {
      cursorTrailPointsRef.current = []
      cursorTrailFrameRef.current = null
      return
    }

    const points = smoothCursorTrailPoints(trimmedPoints)
    const night = isNight
    const themeStrength = night ? 1 : 0.62
    const speedLift = Math.min(1.7, latestPoint.speed * 0.72)

    context.globalCompositeOperation = 'lighter'

    const drawRibbonPass = (widthScale: number, alphaScale: number, blur: number) => {
      const leftEdge: Array<{ x: number; y: number }> = []
      const rightEdge: Array<{ x: number; y: number }> = []

      points.forEach((point, index) => {
        const previous = points[Math.max(0, index - 1)]
        const next = points[Math.min(points.length - 1, index + 1)]
        const tangentX = next.x - previous.x
        const tangentY = next.y - previous.y
        const tangentLength = Math.max(0.001, Math.hypot(tangentX, tangentY))
        const normalX = -tangentY / tangentLength
        const normalY = tangentX / tangentLength
        const progress = index / (points.length - 1)
        const taper = Math.pow(progress, 1.52)
        const velocity = Math.min(1.48, 0.76 + point.speed * 0.28)
        const halfWidth = (0.08 + taper * (3.35 + speedLift)) * widthScale * velocity

        leftEdge.push({
          x: point.x + normalX * halfWidth,
          y: point.y + normalY * halfWidth,
        })
        rightEdge.push({
          x: point.x - normalX * halfWidth,
          y: point.y - normalY * halfWidth,
        })
      })

      const firstPoint = points[0]
      const lastPoint = points[points.length - 1]
      const gradient = context.createLinearGradient(
        firstPoint.x,
        firstPoint.y,
        lastPoint.x,
        lastPoint.y,
      )
      const alpha = alphaScale * idleFade * themeStrength
      gradient.addColorStop(0, 'rgba(255, 255, 255, 0)')
      gradient.addColorStop(0.16, `rgba(255, 255, 255, ${alpha * 0.08})`)
      gradient.addColorStop(0.52, `rgba(255, 255, 255, ${alpha * 0.42})`)
      gradient.addColorStop(0.84, `rgba(255, 255, 255, ${alpha * 0.82})`)
      gradient.addColorStop(1, `rgba(255, 255, 255, ${alpha})`)

      context.save()
      context.filter = blur > 0 ? `blur(${blur}px)` : 'none'
      context.shadowBlur = blur * 0.7
      context.shadowColor = `rgba(255, 255, 255, ${alpha * 0.72})`
      context.fillStyle = gradient
      context.beginPath()
      context.moveTo(leftEdge[0].x, leftEdge[0].y)
      leftEdge.slice(1).forEach((point) => context.lineTo(point.x, point.y))
      rightEdge.slice().reverse().forEach((point) => context.lineTo(point.x, point.y))
      context.closePath()
      context.fill()
      context.restore()
    }

    drawRibbonPass(3.35, 0.11, night ? 7 : 5)
    drawRibbonPass(1.75, 0.28, night ? 3.5 : 2.5)
    drawRibbonPass(0.72, 0.94, 0)

    const headRadius = (night ? 8.5 : 7) + speedLift * 1.3
    const headGlow = context.createRadialGradient(
      latestPoint.x,
      latestPoint.y,
      0,
      latestPoint.x,
      latestPoint.y,
      headRadius,
    )
    headGlow.addColorStop(0, `rgba(255, 255, 255, ${0.98 * idleFade})`)
    headGlow.addColorStop(0.22, `rgba(255, 255, 255, ${0.74 * idleFade * themeStrength})`)
    headGlow.addColorStop(0.58, `rgba(255, 255, 255, ${0.24 * idleFade * themeStrength})`)
    headGlow.addColorStop(1, 'rgba(255, 255, 255, 0)')
    context.fillStyle = headGlow
    context.beginPath()
    context.arc(latestPoint.x, latestPoint.y, headRadius, 0, Math.PI * 2)
    context.fill()

    cursorTrailFrameRef.current = window.requestAnimationFrame(
      (nextFrameTime) => cursorTrailDrawRef.current(nextFrameTime),
    )
  }, [isNight])

  useEffect(() => {
    cursorTrailDrawRef.current = drawCursorTrail
  }, [drawCursorTrail])

  const requestCursorTrailFrame = useCallback(() => {
    if (cursorTrailFrameRef.current !== null || cursorTrailReducedMotionRef.current) return
    cursorTrailFrameRef.current = window.requestAnimationFrame(drawCursorTrail)
  }, [drawCursorTrail])

  const updateCursorGlow = useCallback((event: PointerEvent) => {
    const shell = globeShellRef.current
    const glow = cursorGlowRef.current
    if (!shell || !glow) return

    const bounds = shell.getBoundingClientRect()
    glow.style.setProperty('--cursor-x', `${event.clientX - bounds.left}px`)
    glow.style.setProperty('--cursor-y', `${event.clientY - bounds.top}px`)
    glow.dataset.active = 'true'

    if (event.pointerType !== 'mouse') return
    if (!cursorTrailRef.current || cursorTrailReducedMotionRef.current) return

    if (cursorTrailNeedsResetRef.current) {
      cursorTrailPointsRef.current = []
      lastCursorPointRef.current = null
      cursorTrailNeedsResetRef.current = false
    }

    const coalescedPointerEvents = event.getCoalescedEvents?.() ?? []
    const coalescedEvents = coalescedPointerEvents.length > 0
      ? coalescedPointerEvents
      : [event]
    const frameTime = performance.now()

    coalescedEvents.forEach((pointerEvent, index) => {
      const x = pointerEvent.clientX - bounds.left
      const y = pointerEvent.clientY - bounds.top
      const time = frameTime - (coalescedEvents.length - 1 - index) * 2
      const previous = lastCursorPointRef.current

      if (!previous) {
        lastCursorPointRef.current = { x, y, time }
        cursorTrailPointsRef.current.push({ x, y, time, speed: 0 })
        return
      }

      const distance = Math.hypot(x - previous.x, y - previous.y)
      const elapsed = Math.max(time - previous.time, 4)
      if (distance < 0.85) return

      const speed = Math.min(3.2, distance / elapsed)
      lastCursorPointRef.current = { x, y, time }
      cursorTrailPointsRef.current.push({ x, y, time, speed })
    })

    cursorTrailPointsRef.current = trimCursorTrailPoints(cursorTrailPointsRef.current, frameTime)
      .slice(-cursorTrailMaxPoints)
    requestCursorTrailFrame()
  }, [requestCursorTrailFrame])
  const hideCursorGlow = useCallback(() => {
    if (cursorGlowRef.current) cursorGlowRef.current.dataset.active = 'false'
    lastCursorPointRef.current = null
    cursorTrailNeedsResetRef.current = true
  }, [])

  useEffect(() => {
    window.addEventListener('pointermove', updateCursorGlow, { capture: true, passive: true })
    window.addEventListener('blur', hideCursorGlow)
    document.documentElement.addEventListener('pointerleave', hideCursorGlow)

    return () => {
      window.removeEventListener('pointermove', updateCursorGlow, true)
      window.removeEventListener('blur', hideCursorGlow)
      document.documentElement.removeEventListener('pointerleave', hideCursorGlow)
    }
  }, [hideCursorGlow, updateCursorGlow])

  useEffect(() => {
    const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
    const updateReducedMotion = () => {
      cursorTrailReducedMotionRef.current = reducedMotionQuery.matches
      if (!reducedMotionQuery.matches) return

      cursorTrailPointsRef.current = []
      if (cursorTrailFrameRef.current !== null) {
        window.cancelAnimationFrame(cursorTrailFrameRef.current)
        cursorTrailFrameRef.current = null
      }
      const canvas = cursorTrailRef.current
      const context = canvas?.getContext('2d')
      if (canvas && context) context.clearRect(0, 0, canvas.width, canvas.height)
    }

    updateReducedMotion()
    reducedMotionQuery.addEventListener('change', updateReducedMotion)

    return () => {
      reducedMotionQuery.removeEventListener('change', updateReducedMotion)
      if (cursorTrailFrameRef.current !== null) {
        window.cancelAnimationFrame(cursorTrailFrameRef.current)
      }
    }
  }, [])
  const captureViewer = useCallback(
    (component: CesiumComponentRef<CesiumViewer> | null) => {
      if (viewerRef.current === component) return
      viewerRef.current = component
      setViewerReadyVersion((current) => current + 1)
    },
    [],
  )

  // PR3：可渲染集合只来自 layerData（FR-MR-1）。layerData 的引用由 App 的 useMemo 稳住，
  // 所以这两个 useMemo 的依赖不会每次渲染都变，下游的 useEffect 也不会被反复重建（AC-8）。
  // 访问次数原来是本地 journeyVisitCounts，现在是 LayerPlace.visitCount。
  const mappedCities = useMemo<LayerPlace[]>(() => layerData.places, [layerData])
  // 状态药丸：足迹数字只数足迹地点，与 PR3 口径一致；想去数含 FR-MR-5 合并后的足迹地点。
  const travelPlaceCount = useMemo(
    () => mappedCities.filter((city) => city.layerIds.includes(TRAVEL_LAYER_ID)).length,
    [mappedCities],
  )
  const wantToGoPlaceCount = useMemo(
    () => mappedCities.filter((city) => city.layerIds.includes(WANT_TO_GO_LAYER_ID)).length,
    [mappedCities],
  )

  const mappedRoutes = useMemo(
    () =>
      layerData.routes.map((route) => ({
        ...route,
        fromCityId: route.fromSourceId,
        toCityId: route.toSourceId,
        type: route.kind,
        positions: createRoutePositions(
          route.fromLng,
          route.fromLat,
          route.toLng,
          route.toLat,
          route.kind,
        ),
      })),
    [layerData],
  )
  const activeCityRouteIds = useMemo(
    () =>
      new Set(
        mappedRoutes
          .filter(
            (route) =>
              selectedCityId &&
              route.fromCountryId === selectedCountryId &&
              route.toCountryId === selectedCountryId &&
              (route.fromCityId === selectedCityId ||
                route.toCityId === selectedCityId),
          )
          .map((route) => route.id),
      ),
    [mappedRoutes, selectedCityId, selectedCountryId],
  )
  const activeRoutePairs = mappedRoutes
    .filter((route) => activeCityRouteIds.has(route.id))
    .map((route) => `${route.fromCityId}->${route.toCityId}`)
    .join('|')
  const activeDroneMediaItems = useMemo(
    () =>
      activeDroneMediaCityId
        ? droneMediaItems.filter((item): item is PositionedDroneMediaItem => (
            item.cityId === activeDroneMediaCityId && hasDronePosition(item)
          ))
        : [],
    [activeDroneMediaCityId],
  )
  const selectedDroneMediaCandidate = activeDroneMediaItemId
    ? droneMediaById[activeDroneMediaItemId]
    : undefined
  const selectedDroneMediaItem = selectedDroneMediaCandidate && hasDronePosition(selectedDroneMediaCandidate)
    ? selectedDroneMediaCandidate
    : undefined
  const cameraFocus = useMemo<CameraFocus>(() => {
    if (selectedDroneMediaItem) {
      return { type: 'droneItem', id: selectedDroneMediaItem.id, item: selectedDroneMediaItem }
    }

    if (activeDroneMediaItems.length > 0) {
      return { type: 'droneGroup', id: activeDroneMediaCityId, items: activeDroneMediaItems }
    }

    if (focusPlace) {
      return {
        type: 'place',
        id: focusPlace.entityId,
        lat: focusPlace.lat,
        lng: focusPlace.lng,
        requestId: focusPlace.requestId,
      }
    }

    if (
      selectionMode === 'city' &&
      selectedCity &&
      typeof selectedCity.lat === 'number' &&
      typeof selectedCity.lng === 'number'
    ) {
      return { type: 'city', id: selectedCity.id, lat: selectedCity.lat, lng: selectedCity.lng }
    }

    if (
      selectionMode === 'country' &&
      selectedCountry &&
      typeof selectedCountry.centerLat === 'number' &&
      typeof selectedCountry.centerLng === 'number'
    ) {
      return {
        type: 'country',
        id: selectedCountry.id,
        lat: selectedCountry.centerLat,
        lng: selectedCountry.centerLng,
      }
    }

    return { type: 'overview', id: 'overview', lat: overviewTarget.lat, lng: overviewTarget.lng }
  }, [
    activeDroneMediaItems,
    activeDroneMediaCityId,
    focusPlace,
    selectedCity,
    selectedCountry,
    selectedDroneMediaItem,
    selectionMode,
  ])
  const cameraScale = useMemo<CameraScale>(() => {
    if (cameraFocus.type === 'droneItem') return 'drone'
    if (cameraFocus.type === 'droneGroup') return 'droneGroup'
    return cameraScaleForGlobeScale(globeScale)
  }, [cameraFocus.type, globeScale])
  const cameraFocusKey = useMemo(() => {
    if (cameraFocus.type === 'droneItem') return `drone-item:${cameraFocus.item.id}:${cameraScale}`
    if (cameraFocus.type === 'droneGroup') {
      return `drone-group:${activeDroneMediaCityId}:${cameraFocus.items.map((item) => item.id).join('|')}:${cameraScale}`
    }
    if (cameraFocus.type === 'place') {
      return `place:${cameraFocus.id}:${cameraFocus.requestId}:${cameraScale}`
    }
    if (cameraFocus.type === 'city') {
      return `city:${selectedCityId}:${cameraScale}`
    }
    if (cameraFocus.type === 'country') {
      return `country:${selectedCountryId}:${cameraScale}`
    }
    return `overview:${cameraScale}:${resetVersion}`
  }, [activeDroneMediaCityId, cameraFocus, cameraScale, resetVersion, selectedCityId, selectedCountryId])
  const cameraRuntimeRef = useRef({
    activeDroneMediaCityId,
    activeDroneMediaItemId,
    cameraFocus,
    cameraScale,
    globeScale,
    selectedCityId,
    selectedCountryId,
  })

  useEffect(() => {
    cameraRuntimeRef.current = {
      activeDroneMediaCityId,
      activeDroneMediaItemId,
      cameraFocus,
      cameraScale,
      globeScale,
      selectedCityId,
      selectedCountryId,
    }
  }, [
    activeDroneMediaCityId,
    activeDroneMediaItemId,
    cameraFocus,
    cameraScale,
    globeScale,
    selectedCityId,
    selectedCountryId,
  ])

  useEffect(() => {
    debugCesiumGlobeScaleProp({
      globeScale,
      selectedCountryId,
      selectedCityId,
      activeDroneMediaCityId,
      activeDroneMediaItemId,
    })
  }, [
    activeDroneMediaCityId,
    activeDroneMediaItemId,
    globeScale,
    selectedCityId,
    selectedCountryId,
  ])

  const activateDebugDroneCameraLock = useCallback(() => {
    debugDroneCameraLockUntilRef.current = Date.now() + 3_000
  }, [])

  const executeCameraCommand = useCallback<ExecuteCameraCommand>((request) => {
    const viewer = viewerRef.current?.cesiumElement
    if (!viewer) return false

    const {
      activeDroneMediaCityId,
      activeDroneMediaItemId,
      cameraFocus,
      cameraScale,
      globeScale,
      selectedCityId,
      selectedCountryId,
    } = cameraRuntimeRef.current
    const now = Date.now()
    const debugLockActive = now < debugDroneCameraLockUntilRef.current
    const droneCameraLockActive = Boolean(
      activeDroneMediaItemId ||
      activeDroneMediaCityId ||
      debugLockActive,
    )

    if (
      droneCameraLockActive &&
      !droneLockAllowedCameraSources.has(request.source)
    ) {
      debugCameraBlockedByDroneLock({
        source: request.source,
        reason: request.reason,
        lock: {
          activeDroneMediaCityId,
          activeDroneMediaItemId,
          debugLockActive,
          debugLockRemainingMs: debugLockActive
            ? Math.max(0, debugDroneCameraLockUntilRef.current - now)
            : 0,
        },
        currentFocus: {
          type: cameraFocus.type,
          id: cameraFocus.id,
          scale: cameraScale,
          globeScale,
          selectedCityId,
          selectedCountryId,
        },
        blockedCommand: request.details,
      })
      return false
    }

    const cameraCommandNumber = cameraCommandCountRef.current + 1
    cameraCommandCountRef.current = cameraCommandNumber
    debugCameraCommand(cameraCommandNumber, {
      source: request.source,
      reason: request.reason,
      droneCameraLockActive,
      lock: {
        activeDroneMediaCityId,
        activeDroneMediaItemId,
        debugLockActive,
        debugLockRemainingMs: debugLockActive
          ? Math.max(0, debugDroneCameraLockUntilRef.current - now)
          : 0,
      },
      ...request.details,
    })
    viewer.camera.cancelFlight()
    request.run(viewer)
    return true
  }, [])

  useEffect(() => {
    const viewer = viewerRef.current?.cesiumElement
    if (!viewer) return

    configureViewer(viewer)
  }, [viewerReadyVersion])

  useEffect(() => {
    if (!showMapContent) return undefined

    const viewer = viewerRef.current?.cesiumElement
    if (!viewer) return undefined

    return bindTrackpadOrbit(viewer.scene.canvas, () => viewerRef.current?.cesiumElement)
  }, [showMapContent, viewerReadyVersion])

  useEffect(() => {
    const viewer = viewerRef.current?.cesiumElement
    if (!viewer) return undefined

    const publishAttitudeFromViewer = (currentViewer: CesiumViewer) => {
      if (currentViewer.isDestroyed()) return

      const camera = currentViewer.camera
      const cameraScale = cameraRuntimeRef.current.cameraScale
      publishCameraAttitude({
        defaultPitchDeg: cameraScaleStates[cameraScale].pitch,
        headingDeg: wrapHeadingDegrees(CesiumMath.toDegrees(camera.heading)),
        pitchDeg: CesiumMath.toDegrees(camera.pitch),
        rollDeg: wrapHeadingDegrees(CesiumMath.toDegrees(camera.roll)),
      })
    }

    const applyOrientationReset = () => {
      if (viewer.isDestroyed()) return

      executeCameraCommand({
        details: { scale: cameraRuntimeRef.current.cameraScale },
        reason: 'compass north-up',
        run: (currentViewer) => {
          const cameraScale = cameraRuntimeRef.current.cameraScale
          const cameraState = cameraScaleStates[cameraScale]
          const pitch = CesiumMath.toRadians(cameraState.pitch)
          const duration = orientationResetDuration()
          worldCenterLockSuspendedRef.current = true
          const finishReset = () => {
            worldCenterLockSuspendedRef.current = false
            updateVisibleHemisphereRef.current()
            publishAttitudeFromViewer(currentViewer)
            currentViewer.scene.requestRender()
          }

          const flyOrSet = (
            destination: Cartesian3,
            orientation: {
              direction?: Cartesian3
              heading?: number
              pitch?: number
              roll?: number
              up?: Cartesian3
            },
          ) => {
            if (duration <= 0) {
              currentViewer.camera.setView({ destination, orientation })
              finishReset()
              return
            }
            currentViewer.camera.flyTo({
              complete: finishReset,
              destination,
              duration,
              orientation,
            })
            currentViewer.scene.requestRender()
          }

          if (cameraScale === 'world') {
            const destination = Cartesian3.clone(
              currentViewer.camera.positionWC,
              new Cartesian3(),
            )
            const direction = Cartesian3.normalize(
              Cartesian3.negate(destination, new Cartesian3()),
              new Cartesian3(),
            )
            const right = Cartesian3.normalize(
              Cartesian3.cross(direction, Cartesian3.UNIT_Z, new Cartesian3()),
              new Cartesian3(),
            )
            const up = Cartesian3.normalize(
              Cartesian3.cross(right, direction, new Cartesian3()),
              new Cartesian3(),
            )
            flyOrSet(destination, { direction, up })
            return
          }

          const target = pickViewTarget(currentViewer)
          if (target) {
            const range = Math.min(
              maximumZoomDistance,
              Math.max(
                currentViewer.scene.screenSpaceCameraController.minimumZoomDistance,
                Cartesian3.distance(currentViewer.camera.positionWC, target),
              ),
            )
            const offset = new HeadingPitchRange(0, pitch, range)
            if (duration <= 0) {
              currentViewer.camera.lookAt(target, offset)
              currentViewer.camera.lookAtTransform(Matrix4.IDENTITY)
              finishReset()
              return
            }
            currentViewer.camera.flyToBoundingSphere(new BoundingSphere(target, 1), {
              complete: finishReset,
              duration,
              offset,
            })
            currentViewer.scene.requestRender()
            return
          }

          const cartographic = currentViewer.camera.positionCartographic
          flyOrSet(
            Cartesian3.fromRadians(
              cartographic.longitude,
              cartographic.latitude,
              cartographic.height,
            ),
            {
              heading: 0,
              pitch,
              roll: 0,
            },
          )
        },
        source: 'orientation-reset',
      })
    }

    const syncAttitude = () => publishAttitudeFromViewer(viewer)

    viewer.camera.changed.addEventListener(syncAttitude)
    viewer.scene.postRender.addEventListener(syncAttitude)
    const unregisterReset = registerOrientationResetHandler(applyOrientationReset)
    syncAttitude()
    return () => {
      unregisterReset()
      if (!viewer.isDestroyed()) {
        viewer.camera.changed.removeEventListener(syncAttitude)
        viewer.scene.postRender.removeEventListener(syncAttitude)
      }
    }
  }, [executeCameraCommand, viewerReadyVersion])

  useEffect(() => {
    if (cameraScale !== 'world') return undefined

    const viewer = viewerRef.current?.cesiumElement
    if (!viewer) return undefined

    const lockedPosition = new Cartesian3()
    const positionDirection = new Cartesian3()
    const lockedDirection = new Cartesian3()
    const lockedUp = new Cartesian3()
    const upProjection = new Cartesian3()

    const normalizeLockedUp = () => {
      const upDotDirection = Cartesian3.dot(viewer.camera.upWC, lockedDirection)
      Cartesian3.multiplyByScalar(lockedDirection, upDotDirection, upProjection)
      Cartesian3.subtract(viewer.camera.upWC, upProjection, lockedUp)

      if (Cartesian3.magnitudeSquared(lockedUp) < 1e-8) {
        const zDotDirection = Cartesian3.dot(Cartesian3.UNIT_Z, lockedDirection)
        Cartesian3.multiplyByScalar(lockedDirection, zDotDirection, upProjection)
        Cartesian3.subtract(Cartesian3.UNIT_Z, upProjection, lockedUp)
      }

      if (Cartesian3.magnitudeSquared(lockedUp) < 1e-8) {
        Cartesian3.clone(Cartesian3.UNIT_Y, lockedUp)
      }

      Cartesian3.normalize(lockedUp, lockedUp)
    }

    const lockWorldCenter = () => {
      if (viewer.isDestroyed() || worldCenterLockSuspendedRef.current) return

      Cartesian3.clone(viewer.camera.positionWC, lockedPosition)
      Cartesian3.normalize(viewer.camera.positionWC, positionDirection)
      Cartesian3.negate(positionDirection, lockedDirection)
      const directionDrift = 1 - Cartesian3.dot(
        viewer.camera.directionWC,
        lockedDirection,
      )

      if (directionDrift < 1e-12) return

      normalizeLockedUp()

      viewer.camera.setView({
        destination: lockedPosition,
        orientation: {
          direction: lockedDirection,
          up: lockedUp,
        },
      })
    }

    viewer.scene.preRender.addEventListener(lockWorldCenter)

    return () => {
      if (!viewer.isDestroyed()) {
        viewer.scene.preRender.removeEventListener(lockWorldCenter)
      }
    }
  }, [cameraScale, viewerReadyVersion])

  useEffect(() => {
    if (import.meta.env.PROD) return undefined

    const viewer = viewerRef.current?.cesiumElement
    if (!viewer) return undefined

    const debugCamera = installDebugCameraApi(
      viewer,
      executeCameraCommand,
      activateDebugDroneCameraLock,
    )

    return () => {
      if (debugCamera && window.__travelAtlasDebugCamera === debugCamera) {
        delete window.__travelAtlasDebugCamera
      }
    }
  }, [activateDebugDroneCameraLock, executeCameraCommand, viewerReadyVersion])

  useEffect(() => {
    const viewer = viewerRef.current?.cesiumElement
    if (!viewer) return

    const updateVisibleHemisphere = () => {
      const cameraPosition = viewer.camera.positionWC
      const nextCityIds = new Set(
        mappedCities
          .filter((city) =>
            isPositionFacingCamera(
              cityPosition(city.lng, city.lat),
              cameraPosition,
            ),
          )
          .map((city) => city.sourceId),
      )
      const nextRouteIds = new Set(
        mappedRoutes
          .filter((route) =>
            route.positions.some((position) =>
              isPositionFacingCamera(position, cameraPosition),
            ),
          )
          .map((route) => route.id),
      )

      setVisibleCityIds((current) => setsMatch(current, nextCityIds) ? current : nextCityIds)
      setVisibleRouteIds((current) => setsMatch(current, nextRouteIds) ? current : nextRouteIds)
    }

    updateVisibleHemisphereRef.current = updateVisibleHemisphere
    updateVisibleHemisphere()
    const updateAfterFirstRender = () => {
      updateVisibleHemisphere()
      viewer.scene.postRender.removeEventListener(updateAfterFirstRender)
    }
    viewer.scene.postRender.addEventListener(updateAfterFirstRender)
    viewer.camera.changed.addEventListener(updateVisibleHemisphere)
    viewer.camera.moveEnd.addEventListener(updateVisibleHemisphere)

    return () => {
      viewer.scene.postRender.removeEventListener(updateAfterFirstRender)
      viewer.camera.changed.removeEventListener(updateVisibleHemisphere)
      viewer.camera.moveEnd.removeEventListener(updateVisibleHemisphere)
      updateVisibleHemisphereRef.current = () => undefined
    }
  }, [mappedCities, mappedRoutes, viewerReadyVersion])

  useEffect(() => {
    const viewer = viewerRef.current?.cesiumElement
    if (!viewer) return
    if (lastCameraFocusKeyRef.current === cameraFocusKey) return

    const {
      activeDroneMediaCityId,
      activeDroneMediaItemId,
      cameraFocus,
      cameraScale,
      globeScale,
      selectedCityId,
      selectedCountryId,
    } = cameraRuntimeRef.current

    debugCameraState({
      userAction: cameraFocus.type,
      focusTargetType: cameraFocus.type,
      focusTargetId: cameraFocus.id,
      cameraScale,
      globeScale,
      activeDroneMediaItemId,
      activeDroneMediaCityId,
      selectedCityId,
      selectedCountryId,
    })

    if (cameraFocus.type === 'droneItem') {
      const cameraState = cameraScaleStates.drone
      const targetPosition = droneMediaPosition(cameraFocus.item)
      debugCameraFocus('drone-item', {
        itemId: cameraFocus.item.id,
        cityId: activeDroneMediaCityId,
        selectedCityId,
        selectedCountryId,
        lat: cameraFocus.item.position.lat,
        lng: cameraFocus.item.position.lng,
        altitudeMeters: cameraFocus.item.position.altitudeMeters,
      })
      const commandAllowed = executeCameraCommand({
        source: 'drone-item',
        reason: 'cameraIntentKey changed',
        details: {
          scale: cameraScale,
          globeScale,
          focusType: cameraFocus.type,
          selectedCityId,
          selectedCountryId,
          activeDroneMediaCityId,
          activeDroneMediaItemId,
          target: {
            itemId: cameraFocus.item.id,
            lat: cameraFocus.item.position.lat,
            lng: cameraFocus.item.position.lng,
            altitudeMeters: cameraFocus.item.position.altitudeMeters,
          },
          destination: 'bounding-sphere',
          rangeOrHeight: cameraState.rangeOrHeight,
        },
        run: (currentViewer) => {
          currentViewer.camera.flyToBoundingSphere(
            new BoundingSphere(targetPosition, 350),
            {
              duration: cameraState.duration,
              offset: new HeadingPitchRange(
                0,
                CesiumMath.toRadians(cameraState.pitch),
                cameraState.rangeOrHeight,
              ),
              complete: updateVisibleHemisphereRef.current,
            },
          )
        },
      })
      if (commandAllowed) lastCameraFocusKeyRef.current = cameraFocusKey
      return
    }

    if (cameraFocus.type === 'droneGroup') {
      const cameraState = cameraScaleStates.droneGroup
      const dronePositions = cameraFocus.items.map(droneMediaPosition)
      const boundingSphere = BoundingSphere.fromPoints(dronePositions)
      const groupRange = Math.min(
        28_000,
        Math.max(12_000, boundingSphere.radius * 7, cameraState.rangeOrHeight),
      )
      debugCameraFocus('drone-group', {
        cityId: activeDroneMediaCityId,
        itemIds: cameraFocus.items.map((item) => item.id),
        selectedCityId,
        selectedCountryId,
        radius: Math.round(boundingSphere.radius),
      })
      const commandAllowed = executeCameraCommand({
        source: 'drone-group',
        reason: 'cameraIntentKey changed',
        details: {
          scale: cameraScale,
          globeScale,
          focusType: cameraFocus.type,
          selectedCityId,
          selectedCountryId,
          activeDroneMediaCityId,
          activeDroneMediaItemId,
          target: {
            itemIds: cameraFocus.items.map((item) => item.id),
            radius: Math.round(boundingSphere.radius),
          },
          destination: 'bounding-sphere',
          rangeOrHeight: groupRange,
        },
        run: (currentViewer) => {
          currentViewer.camera.flyToBoundingSphere(
            boundingSphere,
            {
              duration: cameraState.duration,
              offset: new HeadingPitchRange(
                0,
                CesiumMath.toRadians(cameraState.pitch),
                groupRange,
              ),
              complete: updateVisibleHemisphereRef.current,
            },
          )
        },
      })
      if (commandAllowed) lastCameraFocusKeyRef.current = cameraFocusKey
      return
    }

    // place（Collection「在地图上查看」）与 city / country / overview 共用下面这一条飞行分支：
    // 高度与姿态只由 cameraScale 决定，焦点类型只提供目标坐标。
    const cameraState = cameraScaleStates[cameraScale]
    const targetPosition = Cartesian3.fromDegrees(cameraFocus.lng, cameraFocus.lat, 600)
    debugCameraFocus(cameraFocus.type, {
      activeDroneMediaCityId,
      activeDroneMediaItemId,
      selectedCityId,
      selectedCountryId,
      lat: cameraFocus.lat,
      lng: cameraFocus.lng,
      globeScale,
    })
    const updateFocusOffset = () => {
      const screenPosition = SceneTransforms.worldToWindowCoordinates(
        viewer.scene,
        targetPosition,
      )

      if (!screenPosition) return

      setFocusOffset({
        x: Math.round(screenPosition.x - viewer.canvas.clientWidth / 2),
        y: Math.round(screenPosition.y - viewer.canvas.clientHeight / 2),
      })
      updateVisibleHemisphereRef.current()
    }

    if (cameraScale === 'world') {
      const destination = Cartesian3.fromDegrees(
        cameraFocus.lng,
        cameraFocus.lat,
        cameraState.rangeOrHeight,
      )
      const direction = Cartesian3.normalize(
        Cartesian3.negate(destination, new Cartesian3()),
        new Cartesian3(),
      )
      const right = Cartesian3.normalize(
        Cartesian3.cross(direction, Cartesian3.UNIT_Z, new Cartesian3()),
        new Cartesian3(),
      )
      const up = Cartesian3.normalize(
        Cartesian3.cross(right, direction, new Cartesian3()),
        new Cartesian3(),
      )

      const commandAllowed = executeCameraCommand({
        source: cameraFocus.type,
        reason: 'cameraIntentKey changed',
        details: {
          scale: cameraScale,
          globeScale,
          focusType: cameraFocus.type,
          selectedCityId,
          selectedCountryId,
          activeDroneMediaCityId,
          activeDroneMediaItemId,
          target: {
            lat: cameraFocus.lat,
            lng: cameraFocus.lng,
          },
          destination: 'cartesian-height',
          rangeOrHeight: cameraState.rangeOrHeight,
        },
        run: (currentViewer) => {
          currentViewer.camera.flyTo({
            destination,
            duration: cameraState.duration,
            orientation: {
              direction,
              up,
            },
            complete: updateFocusOffset,
          })
        },
      })
      if (commandAllowed) lastCameraFocusKeyRef.current = cameraFocusKey
      return
    }

    const commandAllowed = executeCameraCommand({
      source: cameraFocus.type,
      reason: 'cameraIntentKey changed',
      details: {
        scale: cameraScale,
        globeScale,
        focusType: cameraFocus.type,
        selectedCityId,
        selectedCountryId,
        activeDroneMediaCityId,
        activeDroneMediaItemId,
        target: {
          lat: cameraFocus.lat,
          lng: cameraFocus.lng,
        },
        destination: 'bounding-sphere',
        rangeOrHeight: cameraState.rangeOrHeight,
      },
      run: (currentViewer) => {
        currentViewer.camera.flyToBoundingSphere(
          new BoundingSphere(
            targetPosition,
            cameraScale === 'country' ? 150_000 : 15_000,
          ),
          {
            duration: cameraState.duration,
            offset: new HeadingPitchRange(
              0,
              CesiumMath.toRadians(cameraState.pitch),
              cameraState.rangeOrHeight,
            ),
            complete: updateFocusOffset,
          },
        )
      },
    })
    if (commandAllowed) lastCameraFocusKeyRef.current = cameraFocusKey
  }, [
    cameraFocusKey,
    executeCameraCommand,
    viewerReadyVersion,
  ])

  return (
    <div
      ref={globeShellRef}
      className={`cesium-atlas-shell absolute inset-0 h-full w-full ${isNight ? 'bg-[#020817]' : 'bg-sky-100'}`}
      data-focus-offset-x={focusOffset.x}
      data-focus-offset-y={focusOffset.y}
      data-visible-city-count={visibleCityIds?.size ?? mappedCities.length}
      data-visible-route-count={visibleRouteIds?.size ?? mappedRoutes.length}
      data-active-route-pairs={activeRoutePairs}
      data-map-source={mapSource}
    >
      <Viewer
        ref={captureViewer}
        full
        animation={false}
        baseLayer={false}
        baseLayerPicker={false}
        fullscreenButton={false}
        geocoder={false}
        homeButton={false}
        infoBox={false}
        navigationHelpButton={false}
        scene3DOnly
        sceneModePicker={false}
        selectionIndicator={false}
        timeline={false}
        useBrowserRecommendedResolution={false}
      >
        <ImageryLayer
          key={`${mapSource}-base`}
          imageryProvider={mapSourceLayers.base}
          brightness={imageryBrightness}
          contrast={imageryContrast}
          saturation={imagerySaturation}
          show={showMapContent}
        />
        {mapSourceLayers.labels ? (
          <ImageryLayer
            key={`${mapSource}-labels`}
            imageryProvider={mapSourceLayers.labels}
            brightness={imageryBrightness}
            contrast={imageryContrast}
            saturation={imagerySaturation}
            show={showMapContent && showLabelsOverlay}
          />
        ) : null}
        <GooglePhotorealisticTiles show={showCity3DTiles && showMapContent} />
        <Scene backgroundColor={Color.fromCssColorString(isNight ? '#010409' : '#dbeafe')} />
        <CesiumGlobe
          baseColor={Color.fromCssColorString(isNight ? '#07111f' : '#cbd5e1')}
          dynamicAtmosphereLighting={isNight}
          enableLighting={isNight}
          show={showMapContent && !showCity3DTiles}
          vertexShadowDarkness={isNight ? 0.48 : 0.3}
        />
        <CesiumSkyBox show={!isNight} />
        <SkyAtmosphere show={showMapContent} />
        <CesiumSun show={!isNight} />
        <ScreenSpaceCameraController
          enableInputs={showMapContent}
          enableLook={cameraScale !== 'world'}
          enableRotate
          enableTilt
          enableTranslate={cameraScale !== 'world'}
          enableZoom
          inertiaZoom={0.46}
          lookEventTypes={globeLookEventTypes}
          rotateEventTypes={globeRotateEventTypes}
          tiltEventTypes={globeTiltEventTypes}
          zoomEventTypes={globeZoomEventTypes}
        />
        <CesiumConstellationSky
          occludeMoonWithEarth={showMapContent}
          overviewHeight={cameraScaleStates.world.rangeOrHeight}
          overviewLat={overviewTarget.lat}
          overviewLng={overviewTarget.lng}
          show={isNight}
        />

        {mappedRoutes.map((route) => {
          const isCityRoute = activeCityRouteIds.has(route.id)
          const isCountryRoute =
            selectedCountryId &&
            (route.fromCountryId === selectedCountryId || route.toCountryId === selectedCountryId)
          const isActive = selectedCityId ? isCityRoute : Boolean(isCountryRoute)
          const isMuted = selectionMode !== 'overview' && !isActive
          const isVisible =
            cameraFocus.type !== 'droneGroup' &&
            cameraFocus.type !== 'droneItem' &&
            (visibleRouteIds?.has(route.id) ?? true) &&
            (selectionMode !== 'city' || isCityRoute)
          const routeColor = Color.fromCssColorString(
            isActive ? selectedAccent : '#bae6fd',
          ).withAlpha(
            isActive ? 0.94 : isMuted ? 0.1 : 0.42,
          )
          const routeOutlineColor = Color.fromCssColorString(
            isActive ? '#f8fafc' : '#38bdf8',
          ).withAlpha(
            isActive ? 0.58 : isMuted ? 0.04 : 0.22,
          )

          return (
            <Entity
              key={route.id}
              name={`${route.journeyId}: ${route.fromCityId} to ${route.toCityId}`}
              show={showMapContent && isVisible}
              polyline={{
                arcType: ArcType.NONE,
                clampToGround: false,
                material: new PolylineOutlineMaterialProperty({
                  color: routeColor,
                  outlineColor: routeOutlineColor,
                  outlineWidth: isActive ? 1.2 : 0.8,
                }),
                positions: route.positions,
                width: isActive ? 4 : isMuted ? 1 : 2,
              }}
            />
          )
        })}

        {mappedCities.map((city) => {
          // 纯想去地点（FR-MR-4 / PRD §9.3）：与足迹城市同尺寸的空心圆，想去 accent 描边。
          // 不参与国家高亮、悬停光晕与 isCountryCity 放大；非总览时与其他非本国城市一样变淡。
          // 点击只打开详情卡（FR-WTG-4），sourceId 就是它的 entityId，半球裁剪照常生效。
          if (!city.layerIds.includes(TRAVEL_LAYER_ID)) {
            const isMuted = selectionMode !== 'overview'
            const title = city.title.en ?? city.title.zh ?? city.sourceId

            return (
              <Entity
                key={city.sourceId}
                name={`${title} · want to go`}
                show={showMapContent && (visibleCityIds?.has(city.sourceId) ?? true)}
                position={cityPosition(city.lng, city.lat)}
                onClick={() => onSelectWantToGoPlace?.(city.entityId)}
                point={{
                  color: Color.fromCssColorString(wantToGoAccent).withAlpha(isMuted ? 0.05 : 0.18),
                  disableDepthTestDistance: Number.POSITIVE_INFINITY,
                  outlineColor: Color.fromCssColorString(wantToGoAccent).withAlpha(isMuted ? 0.36 : 1),
                  outlineWidth: 2,
                  pixelSize: 7,
                }}
                label={{
                  backgroundColor: Color.fromCssColorString('#0f172a').withAlpha(0.72),
                  fillColor: Color.WHITE,
                  disableDepthTestDistance: Number.POSITIVE_INFINITY,
                  font: '600 13px Inter, sans-serif',
                  outlineColor: Color.BLACK,
                  outlineWidth: 2,
                  pixelOffset: new Cartesian2(0, -28),
                  // 足迹的标签只在"选中城市 / 当前国家的城市"上显示；纯想去地点两者都不是。
                  show: false,
                  showBackground: true,
                  style: LabelStyle.FILL_AND_OUTLINE,
                  text: title,
                }}
              />
            )
          }

          const isSelected = city.sourceId === selectedCityId
          const isHoveredCountryCity =
            hoveredCountryId !== undefined && city.countryId === hoveredCountryId
          const isCountryCity =
            selectedCountryId !== undefined && city.countryId === selectedCountryId
          const accent = city.accent ?? '#38bdf8'
          // 保持原 `?? 1` 的显示语义：没有到访记录时也显示 1（对等测试按此约定）。
          const visitCount = city.visitCount || 1
          const isMuted =
            selectionMode !== 'overview' && !isSelected && !isCountryCity
          const corePixelSize = isCountryCity ? 12 : 7
          const showHoverGlow = isHoveredCountryCity && !isSelected

          return (
            <Entity
              key={city.sourceId}
              name={`${city.title.en ?? city.title.zh ?? city.sourceId} · ${visitCount} visit records`}
              show={showMapContent && (visibleCityIds?.has(city.sourceId) ?? true)}
              position={cityPosition(city.lng, city.lat)}
              onClick={() => onSelectCity(city.sourceId)}
              billboard={showHoverGlow ? {
                color: Color.WHITE,
                disableDepthTestDistance: Number.POSITIVE_INFINITY,
                height: 38,
                image: cityHoverMarkerImage(accent, corePixelSize),
                width: 38,
              } : undefined}
              point={showHoverGlow ? undefined : {
                color: Color.fromCssColorString(accent).withAlpha(isMuted ? 0.28 : 1),
                disableDepthTestDistance: Number.POSITIVE_INFINITY,
                outlineColor: Color.WHITE.withAlpha(isMuted ? 0.36 : 0.94),
                outlineWidth: isSelected ? 3 : 2,
                pixelSize: isSelected ? 18 : corePixelSize,
              }}
              label={{
                backgroundColor: Color.fromCssColorString(
                  isSelected ? accent : '#0f172a',
                ).withAlpha(isSelected ? 0.9 : 0.72),
                fillColor: Color.WHITE,
                disableDepthTestDistance: Number.POSITIVE_INFINITY,
                font: isSelected ? '700 15px Inter, sans-serif' : '600 13px Inter, sans-serif',
                outlineColor: Color.BLACK,
                outlineWidth: 2,
                pixelOffset: new Cartesian2(0, -28),
                show: isSelected || isCountryCity,
                showBackground: true,
                style: LabelStyle.FILL_AND_OUTLINE,
                text: city.title.en ?? city.title.zh ?? city.sourceId,
              }}
              ellipse={isSelected ? {
                height: 300,
                material: Color.fromCssColorString(accent).withAlpha(0.14),
                outline: true,
                outlineColor: Color.fromCssColorString(accent).withAlpha(0.88),
                semiMajorAxis: 42_000,
                semiMinorAxis: 42_000,
              } : undefined}
            />
          )
        })}

        {mappedCities.map((city) => {
          // FR-MR-5：足迹 + 想去同一地点。足迹标记（上面那个 Entity）一字不改，
          // 另起一个独立 Entity 在右上角叠心形徽标；显隐条件与所属标记相同。
          // 已知限制：Cesium 把"关闭深度测试"实现为把顶点推到近平面，point 用 LEQUAL、
          // billboard 用 LESS，所以徽标与【相邻城市】的点重叠时总在点的下面（世界视角下的冰岛）。
          if (!city.layerIds.includes(TRAVEL_LAYER_ID) || !city.layerIds.includes(WANT_TO_GO_LAYER_ID)) {
            return null
          }
          const isSelected = city.sourceId === selectedCityId
          const isCountryCity =
            selectedCountryId !== undefined && city.countryId === selectedCountryId
          const isMuted =
            selectionMode !== 'overview' && !isSelected && !isCountryCity
          // 默认（7px、无标签）偏移 (9, -9)。标记放大且显示城市名时（选中 / 当前国家的城市），
          // 标签底边约在 -15px，徽标改贴标记右侧、略高于中心，免得被标签盖住（同上面的深度限制）。
          const hasLabel = isSelected || isCountryCity
          const markerPixelSize = isSelected ? 18 : isCountryCity ? 12 : 7
          const badgeOffset = hasLabel
            ? new Cartesian2(markerPixelSize / 2 + 7, -6)
            : new Cartesian2(9, -9)

          return (
            <Entity
              key={`${city.sourceId}__want-to-go-badge`}
              name={`${city.title.en ?? city.title.zh ?? city.sourceId} · want to go`}
              show={showMapContent && (visibleCityIds?.has(city.sourceId) ?? true)}
              position={cityPosition(city.lng, city.lat)}
              // 徽标属于足迹地点：点它与点足迹标记一样进入城市。
              onClick={() => onSelectCity(city.sourceId)}
              billboard={{
                color: Color.WHITE.withAlpha(isMuted ? 0.36 : 1),
                disableDepthTestDistance: Number.POSITIVE_INFINITY,
                height: 14,
                image: wantToGoBadgeImage(wantToGoAccent),
                pixelOffset: badgeOffset,
                width: 14,
              }}
            />
          )
        })}

        {activeDroneMediaItems.map((item, index) => {
          const isSelected = item.id === activeDroneMediaItemId
          const itemNumber = String(index + 1).padStart(2, '0')

          return (
            <Entity
              key={item.id}
              name={`${item.titleEn} ${item.fileName}`}
              show={showMapContent}
              position={droneMediaPosition(item)}
              onClick={() => onSelectDroneMediaItem(item)}
              billboard={{
                color: Color.WHITE.withAlpha(isSelected ? 1 : 0.78),
                disableDepthTestDistance: Number.POSITIVE_INFINITY,
                height: isSelected ? 42 : 32,
                image: dronePinImage,
                scale: isSelected ? 1.08 : 0.92,
                width: isSelected ? 42 : 32,
              }}
              label={{
                backgroundColor: Color.fromCssColorString(
                  isSelected ? '#0ea5e9' : '#020617',
                ).withAlpha(isSelected ? 0.92 : 0.74),
                disableDepthTestDistance: Number.POSITIVE_INFINITY,
                fillColor: Color.WHITE,
                font: isSelected ? '700 13px Inter, sans-serif' : '600 12px Inter, sans-serif',
                outlineColor: Color.BLACK,
                outlineWidth: 2,
                pixelOffset: new Cartesian2(0, -34),
                show: true,
                showBackground: true,
                style: LabelStyle.FILL_AND_OUTLINE,
                text: `Drone ${itemNumber}`,
              }}
              point={{
                color: Color.fromCssColorString(isSelected ? '#7dd3fc' : '#e0f2fe').withAlpha(0.9),
                disableDepthTestDistance: Number.POSITIVE_INFINITY,
                outlineColor: Color.WHITE.withAlpha(0.95),
                outlineWidth: 2,
                pixelSize: isSelected ? 13 : 9,
              }}
            />
          )
        })}
      </Viewer>
      <div
        ref={cursorGlowRef}
        aria-hidden="true"
        className="atlas-cursor-glow"
        data-active="false"
      />
      <canvas
        ref={cursorTrailRef}
        aria-hidden="true"
        className="atlas-cursor-trail"
      />

      <div className="cesium-map-status pointer-events-none absolute left-1/2 top-4 -translate-x-1/2 rounded-full border border-white/14 bg-slate-950/62 px-4 py-2 text-xs font-semibold text-slate-200 shadow-lg backdrop-blur-2xl">
        {travelPlaceCount} mapped cities · {mappedRoutes.length} journey route segments
        {wantToGoPlaceCount > 0 ? ` · ${wantToGoPlaceCount} want-to-go` : null}
      </div>
    </div>
  )
}
