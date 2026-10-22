import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { UIEvent } from 'react'
import { PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen } from 'lucide-react'
import { AtlasHeader } from './components/AtlasHeader'
import type { AtlasPage } from './components/AtlasHeader'
import { CesiumAtlasGlobe } from './components/CesiumAtlasGlobe'
import { CountrySelector } from './components/CountrySelector'
import { PrivateDataNotice } from './components/PrivateDataNotice'
import { CompassButton } from './components/CompassButton'
import type { ConvertToTravelTarget } from './components/ConvertToTravelDialog'
import { LayerPanel } from './components/LayerPanel'
import { LayerTimeFilters } from './components/LayerTimeFilters'
import { MapSourceSwitcher } from './components/MapSourceSwitcher'
import { MouseControlGuide } from './components/MouseControlGuide'
import { DroneMediaCard } from './components/DroneMediaCard'
import { InfoCard } from './components/InfoCard'
import { mediaJobs } from './data/localEditorClient'
import type { CityPhotoGalleryRequest } from './components/CityPhotoGalleryModal'
import { Timeline } from './components/Timeline'
import { ReleaseUpdateButton } from './components/ReleaseUpdateButton'
import { WantToGoCard } from './components/WantToGoCard'
import { JourneyViewToggle } from './components/JourneyViewToggle'
import type { JourneyViewMode } from './components/JourneyViewToggle'
import { JourneyYearCards } from './components/JourneyYearCards'
import { useStableCallback } from './components/useStableCallback'
import { useHeldWhileHidden } from './components/useHeldWhileHidden'
import type { DroneMediaItem } from './data/droneMedia'
import { useDroneMedia } from './data/droneMedia'
import { localEditorAvailable } from './data/editorState'
import type { LocalConvertToTravelResult } from './data/localEditorApi'
import { getInitialLayerVisibility, rememberLayerVisibility } from './data/layerVisibility'
import { readLayerTimeFilters, rememberLayerTimeFilters } from './data/layerTimeFilters'
import { HoldDataWhileHidden, useBrowseProjection, useCollectionEntries, useVisiblePlaces } from './data/appStore'
import { PausedWhileHidden } from './components/PausedWhileHidden'
import { includedBrowseRecordKeys, countMappedTravelRecords } from './data/derive/browseTimeProjection'
import { coordinateForRecord } from './data/derive/travelAtlas'
import { wantToGoCardRecordOf, type WantToGoCardRecord } from './data/derive/wantToGo'
import { City3DToggle } from './extensions/City3DToggle'
import { rememberCity3DEnabled, resolveInitialCity3DEnabled } from './extensions/city3dPreference'
import { googleConfigured } from './extensions/googleImagery'
import { LabelsToggle } from './extensions/LabelsToggle'
import { getInitialMapLabelsEnabled, rememberMapLabelsEnabled } from './extensions/labelsPreference'
import { getInitialMapSource, mapSourceHasLabelOverlay, rememberMapSource } from './extensions/mapSources'
import type { MapSourceId } from './extensions/mapSources'
import { useReleaseUpdates } from './data/releaseUpdates'
import { useTravelAtlas } from './data/travelAtlas'
import { useWorldGraph } from './data/worldGraph'
import { useUiLocale } from './i18n/useUiLocale'
import { readAtlasViewState, rememberAtlasViewState } from './data/viewState'
import { useWantToGo } from './data/wantToGo'
import type { CollectionEntry } from './worldgraph/collection'
import { officialLayers, TRAVEL_LAYER_ID, WANT_TO_GO_LAYER_ID } from './worldgraph/layers'
import { isTimeFilterActive } from './worldgraph/timeFilter'
import type { LayerTimeFilters as TimeFilterState } from './worldgraph/timeQuery'
import { recordRefKey } from './worldgraph/recordIdentity'
import { PLANNED_SOURCE } from './worldgraph/adapters/plannedRecords'
import type { EntityId, LayerId } from './worldgraph/types'
import type { CityId, CountryId, JourneyDay, SelectionMode } from './types/travel'

const DronePanoramaModal = lazy(() =>
  import('./components/DronePanoramaModal').then((module) => ({
    default: module.DronePanoramaModal,
  })),
)

// 首屏地图之外、只在切页或点开时才用到的组件（第 5B 批），公开版与个人版都按需加载：
// Collection 与更新页第一次打开时才加载并挂载，之后一直挂载，保留各自的滚动位置；城市照片浮层点开时才加载。
// Journey 页不拆：它的时间线在切页后会被立即读取（time-filters 浏览器用例），而且体积很小。
const CollectionPage = lazy(() => import('./components/CollectionPage').then((module) => ({ default: module.CollectionPage })))
const ReleaseUpdatePage = lazy(() => import('./components/UpdateChecker').then((module) => ({ default: module.ReleaseUpdatePage })))
const CityPhotoGalleryModal = lazy(() => import('./components/CityPhotoGalleryModal').then((module) => ({ default: module.CityPhotoGalleryModal })))

// 只在本地编辑时出现的组件（第 5B 批）：按需加载，而且只在 `import.meta.env.DEV && localEditorAvailable` 时才定义。
// 构建时前半句是字面量 false，Rolldown 在打包阶段就删掉这些 import()，任何构建产物里都没有它们的 chunk；
// 只写 localEditorAvailable 不够，原因见 ./data/localEditorClient.ts。对话框只在打开时渲染，第一次打开时才加载。
const MediaRecoveryCenter = import.meta.env.DEV && localEditorAvailable
  ? lazy(() => import('./components/MediaRecoveryCenter').then((module) => ({ default: module.MediaRecoveryCenter })))
  : undefined
const WantToGoAddDialog = import.meta.env.DEV && localEditorAvailable
  ? lazy(() => import('./components/WantToGoAddDialog').then((module) => ({ default: module.WantToGoAddDialog })))
  : undefined
const ConvertToTravelDialog = import.meta.env.DEV && localEditorAvailable
  ? lazy(() => import('./components/ConvertToTravelDialog').then((module) => ({ default: module.ConvertToTravelDialog })))
  : undefined

const overviewDistance = 3.25
const countryDistance = 1.95
const cityDistance = 1.38
const sidebarMediaQuery = '(min-width: 1100px)'
const mobilePanelMediaQuery = '(width < 768px)'
// 可滚动页面滚离顶部超过这个距离（px），顶部标题才换上玻璃背景。
const headerBackdropScrollThreshold = 12
type CameraScale = 'city' | 'country' | 'world'
type MobilePanel = 'countries' | 'details'
type ImageryTuning = {
  brightness: number
  contrast: number
  saturation: number
}

// The app has one (night) theme; these are its imagery defaults.
const imageryTuningDefaults: ImageryTuning = { brightness: 0.68, contrast: 1.08, saturation: 0.86 }

const cameraScaleForDistance = (distance: number): CameraScale => {
  if (distance < 1.68) return 'city'
  if (distance < 2.55) return 'country'
  return 'world'
}

function App() {
  const { locale, t } = useUiLocale()
  // 3C-5 D: the data of the page, through hooks (a save moves them on without a reload).
  const { cityById, countryById, getCitiesForCountry, journeyDays, shouldHideCityFromNavigation, travelAtlasDisplay } = useTravelAtlas()
  const { droneMediaById, hasDroneMedia } = useDroneMedia()
  const { worldGraphSnapshot } = useWorldGraph()
  const { hiddenWantToGoItems } = useWantToGo()
  // 概览视角目标点（PR3c），由这里传给地图，地图不再自己读 travelAtlas。
  const overviewTarget = travelAtlasDisplay.overviewTarget
  useEffect(() => {
    if (!localEditorAvailable) return
    const discover = () => { void mediaJobs.refresh().catch(() => undefined) }
    const visible = () => { if (document.visibilityState === 'visible') discover() }
    discover()
    window.addEventListener('focus', discover)
    document.addEventListener('visibilitychange', visible)
    return () => {
      window.removeEventListener('focus', discover)
      document.removeEventListener('visibilitychange', visible)
    }
  }, [])
  const restoredViewState = useMemo(() => readAtlasViewState(), [])
  const restoredCityId = restoredViewState.selectedCityId && cityById[restoredViewState.selectedCityId]
    ? restoredViewState.selectedCityId
    : undefined
  const restoredCountryId = cityById[restoredCityId ?? '']?.countryId
    ?? (restoredViewState.selectedCountryId && countryById[restoredViewState.selectedCountryId]
      ? restoredViewState.selectedCountryId
      : undefined)
  const restoredSelectionMode: SelectionMode = restoredViewState.selectionMode === 'city' && restoredCityId
    ? 'city'
    : restoredViewState.selectionMode === 'country' && restoredCountryId
      ? 'country'
      : 'overview'
  const restoredGlobeDistance = typeof restoredViewState.globeDistance === 'number'
    && Number.isFinite(restoredViewState.globeDistance)
    && restoredViewState.globeDistance >= 0.8
    && restoredViewState.globeDistance <= 5.5
    ? restoredViewState.globeDistance
    : restoredSelectionMode === 'city'
      ? cityDistance
      : restoredSelectionMode === 'country'
        ? countryDistance
        : overviewDistance
  const defaultSelectedDayId = [...journeyDays].sort((left, right) =>
    `${right.date}-${right.id}`.localeCompare(`${left.date}-${left.id}`),
  )[0]?.id ?? ''
  const restoredSelectedDayId = restoredViewState.selectedDayId
    && journeyDays.some((day) => day.id === restoredViewState.selectedDayId)
    ? restoredViewState.selectedDayId
    : defaultSelectedDayId
  const restoredActivePage: AtlasPage = ['map', 'journey', 'collection', 'about'].includes(restoredViewState.activePage ?? '')
    ? restoredViewState.activePage as AtlasPage
    : 'map'
  const restoredPageBeforeUpdate: Exclude<AtlasPage, 'about'> = restoredViewState.pageBeforeUpdate === 'journey'
    || restoredViewState.pageBeforeUpdate === 'collection'
    ? restoredViewState.pageBeforeUpdate
    : 'map'
  const restoredJourneyViewMode: JourneyViewMode = restoredViewState.journeyViewMode === 'yearCards'
    ? 'yearCards'
    : 'timeline'
  const restoredDroneCityId = restoredViewState.activeDroneMediaCityId
    && cityById[restoredViewState.activeDroneMediaCityId]
    ? restoredViewState.activeDroneMediaCityId
    : undefined
  const restoredDroneItemId = restoredViewState.activeDroneMediaItemId
    && droneMediaById[restoredViewState.activeDroneMediaItemId]?.cityId === restoredDroneCityId
    ? restoredViewState.activeDroneMediaItemId
    : undefined

  const [selectedCountryId, setSelectedCountryId] = useState<CountryId | undefined>(restoredCountryId)
  const [selectedCityId, setSelectedCityId] = useState<CityId | undefined>(restoredCityId)
  const [hoveredCountryId, setHoveredCountryId] = useState<CountryId | undefined>()
  const [selectedDayId, setSelectedDayId] = useState(restoredSelectedDayId)
  const [selectionMode, setSelectionMode] = useState<SelectionMode>(restoredSelectionMode)
  const [globeDistance, setGlobeDistance] = useState(restoredGlobeDistance)
  const [globeResetVersion, setGlobeResetVersion] = useState(0)
  const [activePage, setActivePage] = useState<AtlasPage>(restoredActivePage)
  // 打开过的页面（第 5B 批）：按需加载的 Collection 与更新页从第一次打开起才挂载，切走后保持挂载。
  const [visitedPages, setVisitedPages] = useState<ReadonlySet<AtlasPage>>(() => new Set([restoredActivePage]))
  // 当前页面是否已滚离顶部，决定顶部标题的玻璃背景。页面的滚动位置不随刷新恢复，初值为 false。
  const [pageScrolled, setPageScrolled] = useState(false)
  // 当前页面滚动条占的宽度（px）：玻璃背景右侧让出这一段，经典滚动条不被压暗；浮层滚动条为 0。
  const [pageScrollbarWidth, setPageScrollbarWidth] = useState(0)
  const journeyStageRef = useRef<HTMLDivElement>(null)
  const collectionStageRef = useRef<HTMLDivElement>(null)
  const updateStageRef = useRef<HTMLDivElement>(null)
  const [pageBeforeUpdate, setPageBeforeUpdate] = useState<Exclude<AtlasPage, 'about'>>(restoredPageBeforeUpdate)
  const [imageryTuning, setImageryTuning] = useState(imageryTuningDefaults)
  const [mapSource, setMapSource] = useState<MapSourceId>(getInitialMapSource)
  const [city3DEnabled, setCity3DEnabled] = useState(() => resolveInitialCity3DEnabled(googleConfigured))
  // The globe hides itself while City 3D is on, so what it receives is gated by the Google key too.
  const city3DActive = googleConfigured && city3DEnabled
  // 3C-5 D: stable (the globe is memoized).
  const disableCity3D = useCallback(() => {
    setCity3DEnabled(false)
    rememberCity3DEnabled(false)
  }, [])
  const [mapLabelsEnabled, setMapLabelsEnabled] = useState(getInitialMapLabelsEnabled)
  const [layerVisibility, setLayerVisibility] = useState(getInitialLayerVisibility)
  const [restoredTimeFilters] = useState(readLayerTimeFilters)
  const [timeFilters, setTimeFilters] = useState<TimeFilterState>(restoredTimeFilters.filters)
  const [timeStorageWarning, setTimeStorageWarning] = useState(restoredTimeFilters.warning)
  const [timeFiltersRestored, setTimeFiltersRestored] = useState(restoredTimeFilters.restored)
  const [timeFiltersOpen, setTimeFiltersOpen] = useState(false)
  const [timeFilterLayer, setTimeFilterLayer] = useState<LayerId>('travel')
  const timeFilterButtonRef = useRef<HTMLButtonElement>(null)
  const timeFilterPanelRef = useRef<HTMLElement>(null)
  useEffect(() => {
    if (timeFiltersOpen && (activePage === 'map' || activePage === 'journey')) {
      timeFilterPanelRef.current?.querySelector<HTMLElement>(`[data-layer="${timeFilterLayer}"] summary`)?.focus({ preventScroll: true })
    }
  }, [timeFiltersOpen, timeFilterLayer, activePage])
  const closeTimeFilters = () => {
    setTimeFiltersOpen(false)
    timeFilterButtonRef.current?.focus({ preventScroll: true })
  }
  const [journeyViewMode, setJourneyViewMode] = useState<JourneyViewMode>(restoredJourneyViewMode)
  const [activeDroneMediaCityId, setActiveDroneMediaCityId] = useState<CityId | undefined>(restoredDroneCityId)
  const [activeDroneMediaItemId, setActiveDroneMediaItemId] = useState<string | undefined>(restoredDroneItemId)
  const [panoramaModalItem, setPanoramaModalItem] = useState<DroneMediaItem>()
  const [cityPhotoGallery, setCityPhotoGallery] = useState<CityPhotoGalleryRequest>()
  // 想去详情卡（FR-WTG-4）与添加对话框（FR-WTG-3）。都不进 viewState：保存后整页刷新即关闭（规格 §2 第 7 条）。
  const [selectedWantToGoEntityId, setSelectedWantToGoEntityId] = useState<EntityId>()
  const [selectedWantToGoRecord, setSelectedWantToGoRecord] = useState<WantToGoCardRecord>()
  const [isAddWantToGoOpen, setIsAddWantToGoOpen] = useState(false)
  // 「标记为去过」对话框（PR9）：Collection 卡片与想去详情卡共用这一份，同样不进 viewState。
  const [convertTarget, setConvertTarget] = useState<ConvertToTravelTarget>()
  // Collection「在地图上查看」的镜头目标（PR7）。选城市 / 选国家 / 回到总览时清空；
  // 关闭详情卡【不】清空，否则焦点回落到总览，镜头会跳回去。不进 viewState。
  // requestId 每次「在地图上查看」递增：同一地点再点一次，镜头也会重新飞过去。
  const [mapFocusPlace, setMapFocusPlace] = useState<{
    entityId: EntityId
    lat: number
    lng: number
    requestId: number
  }>()
  const viewOnMapRequestIdRef = useRef(0)
  const [sidebarsOpen, setSidebarsOpen] = useState(() => typeof restoredViewState.sidebarsOpen === 'boolean'
    ? restoredViewState.sidebarsOpen
    : typeof window === 'undefined' || window.matchMedia(sidebarMediaQuery).matches)
  const [isMobileLayout, setIsMobileLayout] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia(mobilePanelMediaQuery).matches)
  const [mobilePanel, setMobilePanel] = useState<MobilePanel>(restoredCityId ? 'details' : 'countries')
  const countryPanelRef = useRef<HTMLDivElement>(null)
  const detailsPanelRef = useRef<HTMLDivElement>(null)
  const countriesButtonRef = useRef<HTMLButtonElement>(null)
  const detailsButtonRef = useRef<HTMLButtonElement>(null)
  const sidebarToggleRef = useRef<HTMLButtonElement>(null)
  const countriesHidden = activePage !== 'map' || !sidebarsOpen || (isMobileLayout && mobilePanel !== 'countries')
  const detailsHidden = activePage !== 'map' || !sidebarsOpen || (isMobileLayout && mobilePanel !== 'details')

  const switchMobilePanel = (panel: MobilePanel) => {
    const hiddenPanel = panel === 'details' ? countryPanelRef.current : detailsPanelRef.current
    if (isMobileLayout && hiddenPanel?.contains(document.activeElement)) {
      const target = panel === 'details' ? detailsButtonRef.current : countriesButtonRef.current
      target?.focus()
    }
    setMobilePanel(panel)
  }

  const openMobileDetails = () => {
    switchMobilePanel('details')
    if (isMobileLayout) setSidebarsOpen(true)
  }
  const releaseUpdates = useReleaseUpdates()
  const selectedCityHasDroneMedia = selectionMode === 'city' && selectedCityId
    ? hasDroneMedia(selectedCityId)
    : false
  const shouldShowDronePanel = Boolean(
    selectionMode === 'city' && selectedCityId && (selectedCityHasDroneMedia || localEditorAvailable),
  )
  const updateImageryTuning = (property: keyof ImageryTuning, value: number) => {
    setImageryTuning((current) => ({ ...current, [property]: value }))
  }

  const resetImageryTuning = () => {
    setImageryTuning({ ...imageryTuningDefaults })
  }

  // 页面的滚动容器：Journey、Collection、About 的舞台里都只有一个子元素，就是该页的滚动容器；地图页没有。
  const getPageScroller = (page: AtlasPage) => {
    const stage = page === 'journey'
      ? journeyStageRef.current
      : page === 'collection'
        ? collectionStageRef.current
        : page === 'about'
          ? updateStageRef.current
          : null
    return stage?.firstElementChild ?? null
  }

  const isPastBackdropThreshold = (scroller: Element | null) =>
    (scroller?.scrollTop ?? 0) > headerBackdropScrollThreshold

  const measureScrollbarWidth = (scroller: Element) =>
    scroller instanceof HTMLElement ? scroller.offsetWidth - scroller.clientWidth : 0

  // 所有切页都经过这里。各页面保留自己的滚动位置，切页时按新页面的滚动容器重新算一次；地图页恒为 false。
  // 地图页没有滚动容器，滚动条宽度保留上一次的值：此时玻璃背景正在淡出，右边缘不跟着跳。
  // 第一次打开 Collection 或更新页时页面还没加载，滚动容器不存在：按未滚动处理，滚动时再由 syncPageScrolled 测量。
  const showPage = (page: AtlasPage) => {
    const scroller = getPageScroller(page)
    setActivePage(page)
    setVisitedPages((visited) => visited.has(page) ? visited : new Set(visited).add(page))
    setPageScrolled(isPastBackdropThreshold(scroller))
    if (scroller) setPageScrollbarWidth(measureScrollbarWidth(scroller))
  }

  const changePrimaryPage = (page: AtlasPage) => {
    if (page !== 'about') {
      setPageBeforeUpdate(page)
    }
    showPage(page)
  }

  const toggleUpdatePage = () => {
    if (activePage === 'about') {
      showPage(pageBeforeUpdate)
      return
    }

    releaseUpdates.markSeen()
    setPageBeforeUpdate(activePage)
    showPage('about')
  }

  // scroll 事件不冒泡，在三个舞台的共同父元素上用捕获阶段统一接收，只认当前页面的滚动容器：
  // 页面里横向滚动的年份卡片行、更新公告的代码块也会触发 scroll，而它们的 scrollTop 恒为 0。
  // 结果变化时才 setState，滚动过程中不会每帧重渲染。
  const syncPageScrolled = (event: UIEvent<HTMLElement>) => {
    const scroller = getPageScroller(activePage)
    if (!scroller || event.target !== scroller) return
    const scrolled = isPastBackdropThreshold(scroller)
    const scrollbarWidth = measureScrollbarWidth(scroller)
    if (scrolled !== pageScrolled) setPageScrolled(scrolled)
    if (scrollbarWidth !== pageScrollbarWidth) setPageScrollbarWidth(scrollbarWidth)
  }

  useEffect(() => {
    const mediaQuery = window.matchMedia(sidebarMediaQuery)
    const syncSidebarVisibility = (event: MediaQueryListEvent) => setSidebarsOpen(event.matches)

    mediaQuery.addEventListener('change', syncSidebarVisibility)
    return () => mediaQuery.removeEventListener('change', syncSidebarVisibility)
  }, [])

  useEffect(() => {
    const mediaQuery = window.matchMedia(mobilePanelMediaQuery)
    const syncMobileLayout = (event: MediaQueryListEvent) => {
      if (countryPanelRef.current?.contains(document.activeElement)
        || detailsPanelRef.current?.contains(document.activeElement)
        || countriesButtonRef.current === document.activeElement
        || detailsButtonRef.current === document.activeElement) {
        sidebarToggleRef.current?.focus()
      }
      setIsMobileLayout(event.matches)
    }
    mediaQuery.addEventListener('change', syncMobileLayout)
    return () => mediaQuery.removeEventListener('change', syncMobileLayout)
  }, [])

  useEffect(() => {
    if (detailsPanelRef.current) detailsPanelRef.current.scrollTop = 0
  }, [selectedCountryId, selectedCityId, selectedWantToGoEntityId])

  useEffect(() => {
    rememberAtlasViewState({
      selectedCountryId,
      selectedCityId,
      selectedDayId,
      selectionMode,
      globeDistance,
      activePage,
      pageBeforeUpdate,
      journeyViewMode,
      activeDroneMediaCityId,
      activeDroneMediaItemId,
      sidebarsOpen,
    })
  }, [
    activeDroneMediaCityId,
    activeDroneMediaItemId,
    activePage,
    globeDistance,
    journeyViewMode,
    pageBeforeUpdate,
    selectedCityId,
    selectedCountryId,
    selectedDayId,
    selectionMode,
    sidebarsOpen,
  ])

  // 地图相机要用的选中项（PR3c）：在 App 侧查表后经 prop 传给地图。字段名与原 City / Country 一致。
  // 必须 useMemo：地图的相机焦点 useMemo 依赖这两个对象，每次渲染传新对象会让焦点被反复重算。
  // 3C-5 D: keyed by the values the camera uses, so new data (a save) with the same place keep the same objects.
  const focusCity = selectedCityId ? cityById[selectedCityId] : undefined
  const [focusCityId, focusCityLat, focusCityLng] = [focusCity?.id, focusCity?.lat, focusCity?.lng]
  const selectedCityFocus = useMemo(
    () => focusCityId !== undefined && focusCityLat !== undefined && focusCityLng !== undefined ? { id: focusCityId, lat: focusCityLat, lng: focusCityLng } : undefined,
    [focusCityId, focusCityLat, focusCityLng],
  )

  const focusCountry = selectedCountryId ? countryById[selectedCountryId] : undefined
  const [focusCountryId, focusCountryLat, focusCountryLng, focusCountryAccent] = [focusCountry?.id, focusCountry?.centerLat, focusCountry?.centerLng, focusCountry?.accent]
  const selectedCountryFocus = useMemo(
    () => focusCountryId !== undefined && focusCountryLat !== undefined && focusCountryLng !== undefined && focusCountryAccent !== undefined
      ? { id: focusCountryId, centerLat: focusCountryLat, centerLng: focusCountryLng, accent: focusCountryAccent }
      : undefined,
    [focusCountryId, focusCountryLat, focusCountryLng, focusCountryAccent],
  )

  // 图层可见性 → 可见图层 id → 地图要渲染的地点与路线（PRD FR-MR-1 / FR-LR-3）。
  // 两层 useMemo 都只依赖 layerVisibility：引用稳定，地图侧才不会被无谓重算连累（AC-8）。
  const visibleLayerIds = useMemo(
    () => officialLayers.filter((layer) => layerVisibility[layer.id] !== false).map((layer) => layer.id),
    [layerVisibility],
  )
  // 3C-5 D: the page's queries come from the data store (computed once per snapshot and arguments, kept while their inputs
  // are; without an active time filter the two place queries are one).
  const layerData = useVisiblePlaces(visibleLayerIds, timeFilters)
  const unfilteredLayerData = useVisiblePlaces(visibleLayerIds)
  const browseProjection = useBrowseProjection(timeFilters)
  const includedRecordKeys = useMemo(() => includedBrowseRecordKeys(browseProjection), [browseProjection])
  const dateQualityCounts = useMemo(() => {
    const counts = { partial: 0, missing: 0, invalid: 0 }
    for (const { record } of browseProjection.matchedRecords) {
      if (record.sourceKind !== 'travel' && record.sourceKind !== 'country-visit') continue
      if (record.date.quality !== 'valid') counts[record.date.quality] += 1
    }
    return counts
  }, [browseProjection])
  const travelTimeActive = timeFilters.travel !== undefined && isTimeFilterActive(timeFilters.travel)
  const wantTimeActive = timeFilters.want_to_go !== undefined && isTimeFilterActive(timeFilters.want_to_go)
  const travelBrowse = useMemo(() => travelTimeActive
    ? { countryIds: [...browseProjection.countryIds], cityIds: [...browseProjection.cityIds] } : undefined, [travelTimeActive, browseProjection])
  const matchingTravelRecordIds = useMemo(() => travelTimeActive ? [...browseProjection.travelRecordIds] : undefined, [travelTimeActive, browseProjection])
  const matchingCountryVisitDates = useMemo(() => travelTimeActive && selectionMode === 'country'
    ? browseProjection.includedRecords.filter(({ record }) => record.sourceKind === 'country-visit' && record.placeId === selectedCountryId).map(({ record }) => record.date)
    : undefined, [travelTimeActive, selectionMode, selectedCountryId, browseProjection])
  const selectedTravelOutsideTime = travelTimeActive && (selectionMode === 'city'
    ? selectedCityId !== undefined && !browseProjection.cityIds.has(selectedCityId)
    : selectionMode === 'country' && selectedCountryId !== undefined && !browseProjection.countryIds.has(selectedCountryId))
  const selectedWantOutsideTime = wantTimeActive && selectedWantToGoRecord !== undefined
    && !includedRecordKeys.has(recordRefKey({ sourceKind: selectedWantToGoRecord.source, recordId: selectedWantToGoRecord.recordId }))
  const changeTimeFilters = (next: TimeFilterState) => {
    setTimeFilters(next)
    setTimeFiltersRestored(false)
    setTimeStorageWarning(!rememberLayerTimeFilters(next))
  }
  const clearTravelTime = () => changeTimeFilters({ ...timeFilters, travel: { includeUncertain: false } })
  const clearWantTime = () => changeTimeFilters({ ...timeFilters, want_to_go: { includeUncertain: false } })

  // 详情卡对应的地点已不在地图的想去层上（图层被关掉、条目被隐藏）时关闭它。只看实体 id（地点 id）：
  // 同一地点在足迹层也有标记时，它就是同一个实体（FR-MR-5 按身份合并，带心形徽标），仍算在图上。
  // 按 React 文档"渲染期间根据新数据调整 state"的写法，不用 effect，避免先画出一帧过期的卡片。
  const selectedWantToGoIsMapped = selectedWantToGoEntityId !== undefined && unfilteredLayerData.places.some(
    (place) => place.entityId === selectedWantToGoEntityId && place.layerIds.includes(WANT_TO_GO_LAYER_ID),
  )
  if (selectedWantToGoEntityId !== undefined && !selectedWantToGoIsMapped) {
    setSelectedWantToGoEntityId(undefined)
  }

  // Collection 列表（PR7）：想去图层的全部条目，含已隐藏与无坐标，不受图层可见性影响（FR-LP-6）。
  // 快照随数据更新（3C-5 D）；语言切换时重算名称排序。
  const collectionEntries = useCollectionEntries(locale)

  const mappedTravelRecordIds = useMemo(() => new Set(Object.values(cityById).flatMap(city => (city.records ?? []).filter(record => coordinateForRecord(record)).map(record => record.id))), [cityById])
  const atlasStats = useMemo(
    () => [
      { value: `${browseProjection.travelStats.definite.countries}`, label: t('journey:countries') },
      { value: `${browseProjection.travelStats.definite.cities}`, label: t('journey:cities') },
      { value: `${browseProjection.travelStats.definite.records}`, label: t('journey:records') },
      { value: `${countMappedTravelRecords(browseProjection, mappedTravelRecordIds)}`, label: t('journey:mapped') },
    ],
    [t, browseProjection, mappedTravelRecordIds],
  )

  const resetOverview = () => {
    switchMobilePanel('countries')
    setSelectedWantToGoEntityId(undefined)
    setMapFocusPlace(undefined)
    setSelectedCountryId(undefined)
    setSelectedCityId(undefined)
    setActiveDroneMediaCityId(undefined)
    setActiveDroneMediaItemId(undefined)
    setSelectionMode('overview')
    setGlobeDistance(overviewDistance)
    setGlobeResetVersion((version) => version + 1)
  }

  const selectCountry = (countryId: CountryId) => {
    setSelectedWantToGoEntityId(undefined)
    setMapFocusPlace(undefined)
    if (selectedCountryId === countryId && selectionMode !== 'overview') {
      resetOverview()
      return
    }

    setSelectedCountryId(countryId)
    setSelectedCityId(undefined)
    setActiveDroneMediaCityId(undefined)
    setActiveDroneMediaItemId(undefined)
    setSelectionMode('country')
    setGlobeDistance(countryDistance)
  }

  const selectCity = (cityId: CityId) => {
    openMobileDetails()
    setSelectedWantToGoEntityId(undefined)
    setMapFocusPlace(undefined)
    if (selectedCityId === cityId) {
      setSelectedCityId(undefined)
      setActiveDroneMediaCityId(undefined)
      setActiveDroneMediaItemId(undefined)
      setSelectionMode('country')
      setGlobeDistance(countryDistance)
      return
    }

    const city = cityById[cityId]
    if (city.countryId) setSelectedCountryId(city.countryId)
    setSelectedCityId(cityId)
    setActiveDroneMediaCityId(undefined)
    setActiveDroneMediaItemId(undefined)
    setSelectionMode('city')
    setGlobeDistance(cityDistance)
  }

  // FR-WTG-4：只打开右侧详情卡，不改 selectionMode、不飞相机。详情卡在右侧栏里，
  // 侧栏收起时点了会"没反应"，所以同时展开侧栏。
  const selectWantToGoPlace = (entityId: EntityId) => {
    openMobileDetails()
    const matches = wantTimeActive ? layerData.places.find(place => place.entityId === entityId)?.recordRefs?.want_to_go ?? [] : undefined
    setSelectedWantToGoRecord(wantToGoCardRecordOf(worldGraphSnapshot.memberships, entityId, matches))
    setSelectedWantToGoEntityId(entityId)
    setSidebarsOpen(true)
  }

  // Collection「在地图上查看」（PR7 规格 §3.3 第 4 条）：切回地图、镜头飞到该地点、打开详情卡。
  // 只对有坐标且未隐藏的条目可用。选中状态的清理与 resetOverview 一致，但不递增 globeResetVersion。
  const viewOnMap = (entry: CollectionEntry) => {
    if (!entry.location || entry.hidden) return
    openMobileDetails()

    // 想去图层被关掉时地图上没有这个点：打开它并记住（与图层面板的开关同一条路径）。
    if (layerVisibility[WANT_TO_GO_LAYER_ID] === false) {
      const next = { ...layerVisibility, [WANT_TO_GO_LAYER_ID]: true }
      setLayerVisibility(next)
      rememberLayerVisibility(next)
    }

    setSelectedCountryId(undefined)
    setSelectedCityId(undefined)
    setActiveDroneMediaCityId(undefined)
    setActiveDroneMediaItemId(undefined)
    setSelectionMode('overview')
    setGlobeDistance(countryDistance)
    viewOnMapRequestIdRef.current += 1
    setMapFocusPlace({
      entityId: entry.entityId,
      lat: entry.location.lat,
      lng: entry.location.lng,
      requestId: viewOnMapRequestIdRef.current,
    })
    setSelectedWantToGoEntityId(entry.entityId)
    setSelectedWantToGoRecord({ source: entry.source === PLANNED_SOURCE ? 'planned' : 'want-to-go', recordId: entry.recordId ?? '' })
    setSidebarsOpen(true)
    changePrimaryPage('map')
  }

  // 转换成功（PR9 规格 §2 第 8 条）：切到 Map 页并选中新国家与新城市，落在这座城市上。3C-5 D：写入完成时新足迹已在页面
  // 数据里（不再整页刷新），所以直接选中；原来刷新后的视图恢复做的事在这里做。
  // 足迹图层被关掉时一并打开，否则选中的新城市在地图上没有标记（与「在地图上查看」打开想去图层同理）。
  const showConvertedPlace = (result: LocalConvertToTravelResult) => {
    if (layerVisibility[TRAVEL_LAYER_ID] === false) {
      const next = { ...layerVisibility, [TRAVEL_LAYER_ID]: true }
      setLayerVisibility(next)
      rememberLayerVisibility(next)
    }
    setConvertTarget(undefined)
    openMobileDetails()
    setSelectedWantToGoEntityId(undefined)
    setSelectedWantToGoRecord(undefined)
    setMapFocusPlace(undefined)
    setSelectedCountryId(result.countryId)
    setSelectedCityId(result.cityId)
    setSelectedDayId(result.travelRecordId)
    setActiveDroneMediaCityId(undefined)
    setActiveDroneMediaItemId(undefined)
    setSelectionMode('city')
    setGlobeDistance(cityDistance)
    changePrimaryPage('map')
    setSidebarsOpen(true)
  }

  // 3C-5 D: stable handlers for the memoized Collection cards.
  const stableViewOnMap = useStableCallback(viewOnMap)
  const openAddWantToGo = useStableCallback(() => setIsAddWantToGoOpen(true))

  const selectDroneMedia = (cityId: CityId) => {
    const city = cityById[cityId]
    if (!city || !hasDroneMedia(cityId)) return
    openMobileDetails()

    if (activeDroneMediaCityId === cityId) {
      setActiveDroneMediaCityId(undefined)
      setActiveDroneMediaItemId(undefined)
      return
    }

    setMapFocusPlace(undefined)
    if (city.countryId) setSelectedCountryId(city.countryId)
    setSelectedCityId(cityId)
    setActiveDroneMediaCityId(cityId)
    setActiveDroneMediaItemId(undefined)
    setSelectionMode('city')
    setGlobeDistance(cityDistance)
  }

  const selectDroneMediaItem = (item: DroneMediaItem) => {
    if (!item.position) return
    openMobileDetails()
    if (activeDroneMediaItemId === item.id) {
      setActiveDroneMediaItemId(undefined)
      setActiveDroneMediaCityId(undefined)
      return
    }

    setMapFocusPlace(undefined)
    const city = cityById[item.cityId]
    if (city?.countryId && selectedCountryId !== city.countryId) {
      setSelectedCountryId(city.countryId)
    }
    if (selectedCityId !== item.cityId) {
      setSelectedCityId(item.cityId)
    }
    if (activeDroneMediaCityId !== item.cityId) {
      setActiveDroneMediaCityId(item.cityId)
    }
    setActiveDroneMediaItemId(item.id)
    if (selectionMode !== 'city') setSelectionMode('city')
    if (globeDistance !== cityDistance) setGlobeDistance(cityDistance)
  }

  const openPanorama = (item: DroneMediaItem) => {
    if (item.position && activeDroneMediaItemId !== item.id) selectDroneMediaItem(item)
    setPanoramaModalItem(item)
  }

  const changeGlobeDistance = (distance: number) => {
    if (Math.abs(distance - globeDistance) <= 0.001) return

    const cameraScale = cameraScaleForDistance(distance)

    setActiveDroneMediaItemId(undefined)
    setActiveDroneMediaCityId(undefined)

    if (cameraScale === 'city') {
      if (selectedCityId) {
        setSelectionMode('city')
      } else if (selectedCountryId) {
        const firstCountryCity = getCitiesForCountry(selectedCountryId)[0]

        if (firstCountryCity) {
          setSelectedCityId(firstCountryCity.id)
          setSelectionMode('city')
        } else {
          setSelectionMode('country')
        }
      } else {
        setSelectionMode('overview')
      }
    } else if (cameraScale === 'country') {
      setSelectionMode(selectedCountryId ? 'country' : 'overview')
    } else {
      setSelectionMode('overview')
    }

    setGlobeDistance(distance)
  }

  // 3C-5 D: the journey's lists get the travel data as props (memoized: they render only when these change).
  const journeyTravel = useMemo(() => ({ cityById, countryById, journeyDays, shouldHideCityFromNavigation }), [cityById, countryById, journeyDays, shouldHideCityFromNavigation])
  const selectDay = (day: JourneyDay) => {
    openMobileDetails()
    // 城市焦点的优先级低于 place 焦点：凡是"选中一个城市"的入口都要清掉 Collection 的镜头目标。
    setMapFocusPlace(undefined)
    setSelectedDayId(day.id)
    if (day.countryId) setSelectedCountryId(day.countryId)
    setSelectedCityId(day.cityId)
    setActiveDroneMediaCityId(undefined)
    setActiveDroneMediaItemId(undefined)
    setSelectionMode('city')
    setGlobeDistance(cityDistance)
  }
  const selectDayStable = useStableCallback(selectDay)
  // 3C-5 D: the globe is memoized; with these stable, and its places held while another page is up (they are not shown
  // there), a save on another page does not render it again. Its camera still follows the selection there.
  const selectCityStable = useStableCallback(selectCity)
  const selectWantToGoPlaceStable = useStableCallback(selectWantToGoPlace)
  const selectDroneMediaItemStable = useStableCallback(selectDroneMediaItem)
  const selectDroneMediaStable = useStableCallback(selectDroneMedia)
  const mapLayerData = useHeldWhileHidden(layerData, activePage === 'map')
  const [overviewLat, overviewLng] = [overviewTarget.lat, overviewTarget.lng]
  const overviewTargetStable = useMemo(() => ({ lat: overviewLat, lng: overviewLng }), [overviewLat, overviewLng])

  return (
    <main className="theme-night relative h-[100dvh] overflow-clip bg-[#010409] text-slate-950">
      <div className="app-background fixed inset-0 -z-10" />
      <div className="app-grid fixed inset-0 -z-10" />
      <div className="star-field fixed inset-0 -z-10" />
      <AtlasHeader
        activePage={activePage}
        onPageChange={changePrimaryPage}
        scrolled={pageScrolled}
        scrollbarWidth={pageScrollbarWidth}
      />
      <section
        className="atlas-experience cesium-lab-page relative h-[100dvh] w-screen overflow-clip"
        data-page={activePage}
        data-sidebars-open={sidebarsOpen}
        onScrollCapture={syncPageScrolled}
      >
          <div className="atlas-time-query-toolbar" hidden={activePage !== 'map' && activePage !== 'journey'}>
            <button ref={timeFilterButtonRef} type="button" aria-expanded={timeFiltersOpen} aria-controls="atlas-time-query-panel"
              onClick={() => timeFiltersOpen ? closeTimeFilters() : setTimeFiltersOpen(true)}>{t('timeFilter:open')}</button>
            <span>{t(travelTimeActive || wantTimeActive ? 'timeFilter:active' : 'timeFilter:allTime')}</span>
            {travelTimeActive ? <span>{t('layer:travel')} · {timeFilters.travel?.from ?? '…'} – {timeFilters.travel?.to ?? '…'}</span> : null}
            {wantTimeActive ? <span>{t('layer:wantToGo')} · {timeFilters.want_to_go?.from ?? '…'} – {timeFilters.want_to_go?.to ?? '…'}</span> : null}
            {timeFiltersRestored ? <span className="atlas-time-query-restored">{t('timeFilter:restored')}</span> : null}
          </div>
          <aside ref={timeFilterPanelRef} id="atlas-time-query-panel" className="atlas-time-query-panel glass-panel"
            hidden={!timeFiltersOpen || (activePage !== 'map' && activePage !== 'journey')}
            inert={!timeFiltersOpen || (activePage !== 'map' && activePage !== 'journey')}
            aria-label={t('timeFilter:open')} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); closeTimeFilters() } }}>
            <button type="button" className="atlas-time-query-close" onClick={closeTimeFilters}>{t('timeFilter:close')}</button>
            <LayerTimeFilters filters={timeFilters} onChange={changeTimeFilters} storageWarning={timeStorageWarning} activeLayer={timeFilterLayer} />
          </aside>
          {activePage === 'map' && (travelTimeActive || wantTimeActive) && visibleLayerIds.length > 0 && layerData.places.length === 0
            ? <p className="atlas-time-map-empty" role="status">{t('timeFilter:noMapResults')}</p> : null}
          <div className="absolute inset-0 z-0">
            <HoldDataWhileHidden visible={activePage === 'map'}>
            <CesiumAtlasGlobe
              hoveredCountryId={hoveredCountryId}
              imageryBrightness={imageryTuning.brightness}
              imageryContrast={imageryTuning.contrast}
              imagerySaturation={imageryTuning.saturation}
              mapSource={mapSource}
              showCity3DTiles={city3DActive}
              onCity3DUnavailable={disableCity3D}
              showLabelsOverlay={mapLabelsEnabled}
              selectedCountryId={selectedCountryId}
              selectedCityId={selectedCityId}
              overviewTarget={overviewTargetStable}
              selectedCity={selectedCityFocus}
              selectedCountry={selectedCountryFocus}
              selectionMode={selectionMode}
              globeScale={globeDistance}
              resetVersion={globeResetVersion}
              showMapContent={activePage === 'map'}
              layerData={mapLayerData}
              activeDroneMediaCityId={activeDroneMediaCityId}
              activeDroneMediaItemId={activeDroneMediaItemId}
              onSelectCity={selectCityStable}
              onSelectWantToGoPlace={selectWantToGoPlaceStable}
              onSelectDroneMediaItem={selectDroneMediaItemStable}
              focusPlace={mapFocusPlace}
            />
            </HoldDataWhileHidden>
          </div>

          <div className="pointer-events-none absolute inset-0 z-20">
            {/* RFC-LOC-1 PR3b-1 / PR5a：个人模式下旧数据还没迁移时的迁移提示，或没有任何足迹与想去时的空状态；其他情况下组件什么都不渲染。 */}
            {activePage === 'map' ? <PrivateDataNotice /> : null}
            <div
              className="atlas-overlay-frame absolute bottom-0"
              data-page={activePage}
              data-sidebars-open={sidebarsOpen}
              data-mobile-panel={mobilePanel}
            >
              <div
                className="atlas-mobile-panel-switch"
                role="group"
                aria-label={t('appShell:mapPanels')}
                aria-hidden={!isMobileLayout || activePage !== 'map' || !sidebarsOpen}
                inert={!isMobileLayout || activePage !== 'map' || !sidebarsOpen}
              >
                <button ref={countriesButtonRef} type="button" aria-pressed={mobilePanel === 'countries'} aria-controls="atlas-country-panel" onClick={() => switchMobilePanel('countries')}>
                  {t('appShell:countriesPanel')}
                </button>
                <button ref={detailsButtonRef} type="button" aria-pressed={mobilePanel === 'details'} aria-controls="atlas-details-panel" onClick={() => switchMobilePanel('details')}>
                  {t('appShell:detailsPanel')}
                </button>
              </div>
              <div id="atlas-country-panel" className="atlas-country-stack" ref={countryPanelRef} aria-hidden={countriesHidden} inert={countriesHidden}>
                <PausedWhileHidden visible={activePage === 'map'}>
                <CountrySelector
                browse={travelBrowse}
                selectedCountryId={selectedCountryId}
                selectedCityId={selectedCityId}
                activeDroneMediaCityId={activeDroneMediaCityId}
                globeDistance={globeDistance}
                imageryBrightness={imageryTuning.brightness}
                imageryContrast={imageryTuning.contrast}
                imagerySaturation={imageryTuning.saturation}
                onBrightnessChange={(value) => updateImageryTuning('brightness', value)}
                onContrastChange={(value) => updateImageryTuning('contrast', value)}
                onHoverCountry={setHoveredCountryId}
                onResetImageryTuning={resetImageryTuning}
                onSaturationChange={(value) => updateImageryTuning('saturation', value)}
                onSelectCountry={selectCountry}
                onSelectCity={selectCityStable}
                onSelectDroneMedia={selectDroneMediaStable}
                onDistanceChange={changeGlobeDistance}
                onResetView={resetOverview}
              />
                </PausedWhileHidden>
              </div>

              <div
                id="atlas-details-panel"
                ref={detailsPanelRef}
                aria-hidden={detailsHidden}
                inert={detailsHidden}
                className={`atlas-right-stack ${
                  shouldShowDronePanel ? 'atlas-right-stack-with-drone' : ''
                }`}
              >
                <PausedWhileHidden visible={activePage === 'map'}>
                {selectedWantToGoEntityId ? (
                  <WantToGoCard
                    key={`want-to-go-${selectedWantToGoEntityId}`}
                    entityId={selectedWantToGoEntityId}
                    explicitRecord={selectedWantToGoRecord}
                    outsideTimeFilter={selectedWantOutsideTime}
                    onClearTimeFilter={clearWantTime}
                    onClose={() => setSelectedWantToGoEntityId(undefined)}
                    onConvertToTravel={setConvertTarget}
                  />
                ) : null}

                <InfoCard
                  key={`info-${selectionMode}-${selectedCountryId ?? 'none'}-${selectedCityId ?? 'none'}`}
                  mode={selectionMode}
                  selectedCountryId={selectedCountryId}
                  selectedCityId={selectedCityId}
                  matchingTravelRecordIds={matchingTravelRecordIds}
                  matchingCountryVisitDates={matchingCountryVisitDates}
                  outsideTimeFilter={selectedTravelOutsideTime}
                  onClearTimeFilter={clearTravelTime}
                  onSelectCity={selectCity}
                  onOpenCityPhotos={setCityPhotoGallery}
                />

                {shouldShowDronePanel ? (
                  <DroneMediaCard
                    key={`drone-${selectedCityId ?? 'none'}`}
                    cityId={selectedCityId}
                    activeItemId={activeDroneMediaItemId}
                    onSelectItem={selectDroneMediaItem}
                    onOpenPanorama={openPanorama}
                  />
                ) : null}

                <MouseControlGuide />
                </PausedWhileHidden>
              </div>

            </div>
          </div>

          <div className="atlas-map-controls">
            <button
              ref={sidebarToggleRef}
              type="button"
              className="atlas-dock-button atlas-sidebars-toggle pointer-events-auto"
              aria-pressed={sidebarsOpen}
              aria-label={t(isMobileLayout ? (sidebarsOpen ? 'appShell:hidePanel' : 'appShell:showPanel') : (sidebarsOpen ? 'appShell:hideSidebars' : 'appShell:showSidebars'))}
              title={t(isMobileLayout ? (sidebarsOpen ? 'appShell:hidePanel' : 'appShell:showPanel') : (sidebarsOpen ? 'appShell:hideSidebars' : 'appShell:showSidebars'))}
              onClick={() => setSidebarsOpen((open) => !open)}
            >
              <span className="atlas-sidebars-toggle-icons" aria-hidden="true">
                {sidebarsOpen ? (
                  <>
                    <PanelLeftClose />
                    <PanelRightClose />
                  </>
                ) : (
                  <>
                    <PanelLeftOpen />
                    <PanelRightOpen />
                  </>
                )}
              </span>
            </button>
            <CompassButton />
            <LayerPanel
              onOpenTimeFilter={layerId => { setTimeFilterLayer(layerId); setTimeFiltersOpen(true) }}
              visibility={layerVisibility}
              onToggle={(layerId, visible) => {
                const next = { ...layerVisibility, [layerId]: visible }
                setLayerVisibility(next)
                rememberLayerVisibility(next)
              }}
              hiddenWantToGoItems={hiddenWantToGoItems}
              onAddWantToGo={() => setIsAddWantToGoOpen(true)}
            />
            <MapSourceSwitcher
              value={mapSource}
              onChange={(source) => {
                setMapSource(source)
                rememberMapSource(source)
              }}
            />
            <LabelsToggle
              available={mapSourceHasLabelOverlay(mapSource)}
              enabled={mapLabelsEnabled}
              onChange={(enabled) => {
                setMapLabelsEnabled(enabled)
                rememberMapLabelsEnabled(enabled)
              }}
            />
            <City3DToggle
              enabled={city3DEnabled}
              onChange={(enabled) => {
                setCity3DEnabled(enabled)
                rememberCity3DEnabled(enabled)
              }}
            />
            <ReleaseUpdateButton
              active={activePage === 'about'}
              state={releaseUpdates}
              onToggle={toggleUpdatePage}
            />
          </div>

          <div
            ref={journeyStageRef}
            className="atlas-journey-stage absolute inset-0 z-30"
            aria-hidden={activePage !== 'journey'}
          >
            {/* 3C-5 D: not shown, the page does not render again after every save (PausedWhileHidden); its scroll position stays. */}
            <PausedWhileHidden visible={activePage === 'journey'}>
            <div className="atlas-journey-scroll selector-scrollbar h-full overflow-y-auto overscroll-contain">
              <div className="atlas-journey-shell mx-auto w-full max-w-7xl px-5 pb-20 sm:px-8">
                <section className="journey-command-panel">
                  <div className="journey-command-copy">
                    <p className="journey-kicker">{t('journey:chronology')}</p>
                    <h2>{t('journey:heading')}</h2>
                    <p>
                      {t('journey:description')}
                    </p>
                  </div>

                  <div className="journey-command-actions">
                    <JourneyViewToggle value={journeyViewMode} onChange={setJourneyViewMode} />
                  </div>

                  <div className="journey-stats-grid">
                    {atlasStats.map((stat) => (
                      <div key={stat.label} className="journey-stat-card">
                        <p className="journey-stat-value">{stat.value}</p>
                        <p className="journey-stat-label">{stat.label}</p>
                      </div>
                    ))}
                  </div>
                  <p className="atlas-time-query-evidence" role="status">
                    {t('timeFilter:definite')} · {t('journey:records')}: {browseProjection.travelStats.definite.records}
                    {' · '}{t('timeFilter:uncertain')} · {t('journey:records')}: {browseProjection.travelStats.uncertain.records}
                    {' · '}{t('journey:cities')}: {browseProjection.travelStats.uncertain.cities}
                    {' · '}{t('journey:countries')}: {browseProjection.travelStats.uncertain.countries}
                  </p>
                  {travelTimeActive && browseProjection.travelRecordIds.size === 0 ? <p role="status">{t('timeFilter:noResults')}</p> : null}
                  {dateQualityCounts.partial + dateQualityCounts.missing + dateQualityCounts.invalid > 0 ? <p className="atlas-time-query-evidence">
                    {t('timeFilter:dateQuality', dateQualityCounts)}
                  </p> : null}
                </section>

                {journeyViewMode === 'timeline' ? (
                  <Timeline
                    projection={browseProjection}
                    travel={journeyTravel}
                    selectedDayId={selectedDayId}
                    onSelectDay={selectDayStable}
                  />
                ) : (
                  <JourneyYearCards projection={browseProjection} travel={journeyTravel} />
                )}
              </div>
            </div>
            </PausedWhileHidden>
          </div>

          <div
            ref={collectionStageRef}
            className="atlas-collection-stage absolute inset-0 z-30"
            aria-hidden={activePage !== 'collection'}
          >
            {/* 舞台本身常驻（切页的淡入淡出在舞台上）；页面加载期间舞台为空，淡入过程中出现。 */}
            <PausedWhileHidden visible={activePage === 'collection'}>
            {visitedPages.has('collection') ? (
              <Suspense fallback={null}>
                <CollectionPage
                  entries={collectionEntries}
                  onViewOnMap={stableViewOnMap}
                  onAddWantToGo={openAddWantToGo}
                  onConvertToTravel={setConvertTarget}
                />
              </Suspense>
            ) : null}
            </PausedWhileHidden>
          </div>

          <div
            ref={updateStageRef}
            className="atlas-update-stage absolute inset-0 z-30"
            aria-hidden={activePage !== 'about'}
          >
            {visitedPages.has('about') ? (
              <Suspense fallback={null}>
                <ReleaseUpdatePage state={releaseUpdates} />
              </Suspense>
            ) : null}
          </div>
      </section>

      {panoramaModalItem ? (
        <Suspense fallback={null}>
          <DronePanoramaModal
            item={panoramaModalItem}
            onClose={() => setPanoramaModalItem(undefined)}
          />
        </Suspense>
      ) : null}

      {cityPhotoGallery ? (
        <Suspense fallback={null}>
          <CityPhotoGalleryModal
            {...cityPhotoGallery}
            onClose={() => setCityPhotoGallery(undefined)}
          />
        </Suspense>
      ) : null}

      {/* FR-PUB-2 / AC-10：公开构建不挂载添加对话框与转换对话框，构建产物里也没有它们（见文件开头的按需加载）。
          加载期间的占位为空：对话框与恢复中心都是浮层，不占文档流；对话框挂载时焦点照常进入。 */}
      {MediaRecoveryCenter ? (
        <Suspense fallback={null}>
          <MediaRecoveryCenter onOpenTarget={(_countryId, cityId) => {
            const city = cityById[cityId]
            if (!city) return
            changePrimaryPage('map')
            openMobileDetails()
            setSelectedWantToGoEntityId(undefined)
            setMapFocusPlace(undefined)
            setSelectedCountryId(city.countryId)
            setSelectedCityId(cityId)
            setActiveDroneMediaCityId(undefined)
            setActiveDroneMediaItemId(undefined)
            setSelectionMode('city')
            setGlobeDistance(cityDistance)
          }} />
        </Suspense>
      ) : null}
      {WantToGoAddDialog && isAddWantToGoOpen ? (
        <Suspense fallback={null}>
          <WantToGoAddDialog
            open
            onClose={() => setIsAddWantToGoOpen(false)}
          />
        </Suspense>
      ) : null}
      {ConvertToTravelDialog && convertTarget ? (
        <Suspense fallback={null}>
          <ConvertToTravelDialog
            target={convertTarget}
            onClose={() => setConvertTarget(undefined)}
            onConverted={showConvertedPlace}
          />
        </Suspense>
      ) : null}
    </main>
  )
}

export default App
