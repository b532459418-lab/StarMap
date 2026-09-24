import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import type { UIEvent } from 'react'
import { PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen } from 'lucide-react'
import { AtlasHeader } from './components/AtlasHeader'
import type { AtlasPage } from './components/AtlasHeader'
import { CesiumAtlasGlobe } from './components/CesiumAtlasGlobe'
import { CollectionPage } from './components/CollectionPage'
import { CountrySelector } from './components/CountrySelector'
import type { ThemeMode } from './components/DayNightToggle'
import { CompassButton } from './components/CompassButton'
import { ConvertToTravelDialog } from './components/ConvertToTravelDialog'
import type { ConvertToTravelTarget } from './components/ConvertToTravelDialog'
import { LayerPanel } from './components/LayerPanel'
import { MapSourceSwitcher } from './components/MapSourceSwitcher'
import { MouseControlGuide } from './components/MouseControlGuide'
import { DroneMediaCard } from './components/DroneMediaCard'
import { InfoCard } from './components/InfoCard'
import { CityPhotoGalleryModal } from './components/CityPhotoGalleryModal'
import type { CityPhotoGalleryRequest } from './components/CityPhotoGalleryModal'
import { Timeline } from './components/Timeline'
import { ReleaseUpdateButton, ReleaseUpdatePage } from './components/UpdateChecker'
import { WantToGoAddDialog } from './components/WantToGoAddDialog'
import { WantToGoCard } from './components/WantToGoCard'
import { JourneyViewToggle } from './components/JourneyViewToggle'
import type { JourneyViewMode } from './components/JourneyViewToggle'
import { JourneyYearCards } from './components/JourneyYearCards'
import type { DroneMediaItem } from './data/droneMedia'
import { droneMediaById, hasDroneMedia } from './data/droneMedia'
import { localEditorAvailable } from './data/editorState'
import type { LocalConvertToTravelResult } from './data/localEditorApi'
import { getInitialLayerVisibility, rememberLayerVisibility } from './data/layerVisibility'
import { City3DToggle } from './extensions/City3DToggle'
import { getInitialCity3DEnabled, rememberCity3DEnabled } from './extensions/city3dPreference'
import { LabelsToggle } from './extensions/LabelsToggle'
import { getInitialMapLabelsEnabled, rememberMapLabelsEnabled } from './extensions/labelsPreference'
import { getInitialMapSource, mapSourceHasLabelOverlay, rememberMapSource } from './extensions/mapSources'
import type { MapSourceId } from './extensions/mapSources'
import { useReleaseUpdates } from './data/releaseUpdates'
import { cities, cityById, countries, countryById, getCitiesForCountry, journeyDays, travelAtlasDisplay, travelAtlasMeta } from './data/travelAtlas'
import { worldGraphSnapshot } from './data/worldGraph'
import { readAtlasViewState, rememberAtlasViewState } from './data/viewState'
import { hiddenWantToGoItems } from './data/wantToGo'
import { queryCollection } from './worldgraph/collection'
import type { CollectionEntry } from './worldgraph/collection'
import { officialLayers, TRAVEL_LAYER_ID, WANT_TO_GO_LAYER_ID } from './worldgraph/layers'
import { queryVisiblePlaces } from './worldgraph/query'
import type { EntityId } from './worldgraph/types'
import type { CityId, CountryId, JourneyDay, SelectionMode } from './types/travel'

const DronePanoramaModal = lazy(() =>
  import('./components/DronePanoramaModal').then((module) => ({
    default: module.DronePanoramaModal,
  })),
)

const overviewDistance = 3.25
const countryDistance = 1.95
const cityDistance = 1.38
const sidebarMediaQuery = '(min-width: 1100px)'
// 可滚动页面滚离顶部超过这个距离（px），顶部标题才换上玻璃背景。
const headerBackdropScrollThreshold = 12
// 概览视角目标点（PR3c）：模块级数据，引用恒定，由这里传给地图，地图不再自己读 travelAtlas。
const overviewTarget = travelAtlasDisplay.overviewTarget

type CameraScale = 'city' | 'country' | 'world'
type ImageryTuning = {
  brightness: number
  contrast: number
  saturation: number
}

const imageryTuningDefaults: Record<ThemeMode, ImageryTuning> = {
  day: { brightness: 1, contrast: 1, saturation: 1 },
  night: { brightness: 0.68, contrast: 1.08, saturation: 0.86 },
}

const cameraScaleForDistance = (distance: number): CameraScale => {
  if (distance < 1.68) return 'city'
  if (distance < 2.55) return 'country'
  return 'world'
}

function App() {
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
  const [, setHoverCityId] = useState<CityId>()
  const [globeDistance, setGlobeDistance] = useState(restoredGlobeDistance)
  const [globeResetVersion, setGlobeResetVersion] = useState(0)
  const [activePage, setActivePage] = useState<AtlasPage>(restoredActivePage)
  // 当前页面是否已滚离顶部，决定顶部标题的玻璃背景。页面的滚动位置不随刷新恢复，初值为 false。
  const [pageScrolled, setPageScrolled] = useState(false)
  const journeyStageRef = useRef<HTMLDivElement>(null)
  const collectionStageRef = useRef<HTMLDivElement>(null)
  const updateStageRef = useRef<HTMLDivElement>(null)
  const [pageBeforeUpdate, setPageBeforeUpdate] = useState<Exclude<AtlasPage, 'about'>>(restoredPageBeforeUpdate)
  const [imageryTuningByTheme, setImageryTuningByTheme] = useState(imageryTuningDefaults)
  const [mapSource, setMapSource] = useState<MapSourceId>(getInitialMapSource)
  const [city3DEnabled, setCity3DEnabled] = useState(getInitialCity3DEnabled)
  const [mapLabelsEnabled, setMapLabelsEnabled] = useState(getInitialMapLabelsEnabled)
  const [layerVisibility, setLayerVisibility] = useState(getInitialLayerVisibility)
  const [journeyViewMode, setJourneyViewMode] = useState<JourneyViewMode>(restoredJourneyViewMode)
  const [activeDroneMediaCityId, setActiveDroneMediaCityId] = useState<CityId | undefined>(restoredDroneCityId)
  const [activeDroneMediaItemId, setActiveDroneMediaItemId] = useState<string | undefined>(restoredDroneItemId)
  const [panoramaModalItem, setPanoramaModalItem] = useState<DroneMediaItem>()
  const [cityPhotoGallery, setCityPhotoGallery] = useState<CityPhotoGalleryRequest>()
  // 想去详情卡（FR-WTG-4）与添加对话框（FR-WTG-3）。都不进 viewState：保存后整页刷新即关闭（规格 §2 第 7 条）。
  const [selectedWantToGoEntityId, setSelectedWantToGoEntityId] = useState<EntityId>()
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
  const releaseUpdates = useReleaseUpdates()
  const selectedCityHasDroneMedia = selectionMode === 'city' && selectedCityId
    ? hasDroneMedia(selectedCityId)
    : false
  const shouldShowDronePanel = Boolean(
    selectionMode === 'city' && selectedCityId && (selectedCityHasDroneMedia || localEditorAvailable),
  )
  const activeTheme: ThemeMode = 'night'
  const imageryTuning = {
    ...imageryTuningDefaults[activeTheme],
    ...imageryTuningByTheme[activeTheme],
  }

  const updateImageryTuning = (property: keyof ImageryTuning, value: number) => {
    setImageryTuningByTheme((current) => ({
      ...current,
      [activeTheme]: {
        ...current[activeTheme],
        [property]: value,
      },
    }))
  }

  const resetImageryTuning = () => {
    setImageryTuningByTheme((current) => ({
      ...current,
      [activeTheme]: { ...imageryTuningDefaults[activeTheme] },
    }))
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

  // 所有切页都经过这里。各页面保留自己的滚动位置，切页时按新页面的滚动容器重新算一次；地图页恒为 false。
  const showPage = (page: AtlasPage) => {
    setActivePage(page)
    setPageScrolled(isPastBackdropThreshold(getPageScroller(page)))
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
    if (scrolled !== pageScrolled) setPageScrolled(scrolled)
  }

  useEffect(() => {
    document.documentElement.lang = 'zh-CN'
    const mediaQuery = window.matchMedia(sidebarMediaQuery)
    const syncSidebarVisibility = (event: MediaQueryListEvent) => setSidebarsOpen(event.matches)

    mediaQuery.addEventListener('change', syncSidebarVisibility)
    return () => mediaQuery.removeEventListener('change', syncSidebarVisibility)
  }, [])

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
  const selectedCityFocus = useMemo(() => {
    const city = selectedCityId ? cityById[selectedCityId] : undefined
    return city ? { id: city.id, lat: city.lat, lng: city.lng } : undefined
  }, [selectedCityId])

  const selectedCountryFocus = useMemo(() => {
    const country = selectedCountryId ? countryById[selectedCountryId] : undefined
    return country
      ? { id: country.id, centerLat: country.centerLat, centerLng: country.centerLng, accent: country.accent }
      : undefined
  }, [selectedCountryId])

  // 图层可见性 → 可见图层 id → 地图要渲染的地点与路线（PRD FR-MR-1 / FR-LR-3）。
  // 两层 useMemo 都只依赖 layerVisibility：引用稳定，地图侧才不会被无谓重算连累（AC-8）。
  const visibleLayerIds = useMemo(
    () => officialLayers.filter((layer) => layerVisibility[layer.id] !== false).map((layer) => layer.id),
    [layerVisibility],
  )
  const layerData = useMemo(() => queryVisiblePlaces(worldGraphSnapshot, visibleLayerIds), [visibleLayerIds])

  // 详情卡对应的地点已不在地图上（图层被关掉、条目被隐藏）时关闭它。
  // 被 FR-MR-5 并进足迹地点的想去条目仍算在图上。按 React 文档"渲染期间根据新数据调整 state"的写法，
  // 不用 effect，避免先画出一帧过期的卡片。
  const selectedWantToGoIsMapped = selectedWantToGoEntityId !== undefined && layerData.places.some(
    (place) => place.entityId === selectedWantToGoEntityId
      || (place.mergedEntityIds?.includes(selectedWantToGoEntityId) ?? false),
  )
  if (selectedWantToGoEntityId !== undefined && !selectedWantToGoIsMapped) {
    setSelectedWantToGoEntityId(undefined)
  }

  // Collection 列表（PR7）：想去图层的全部条目，含已隐藏与无坐标，不受图层可见性影响（FR-LP-6）。
  // 快照是模块级常量，算一次即可；写入后整页刷新，自然拿到新数据。
  const collectionEntries = useMemo(() => queryCollection(worldGraphSnapshot, WANT_TO_GO_LAYER_ID), [])

  const atlasStats = useMemo(
    () => [
      { value: `${countries.length}`, label: 'Countries / 国家' },
      { value: `${cities.length}`, label: 'Cities / 城市' },
      { value: `${travelAtlasMeta.totalRecords}`, label: 'Records / 行程' },
      { value: `${travelAtlasMeta.recordsWithCoordinates}`, label: 'Mapped / 坐标' },
    ],
    [],
  )

  const resetOverview = () => {
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
    setSelectedWantToGoEntityId(entityId)
    setSidebarsOpen(true)
  }

  // Collection「在地图上查看」（PR7 规格 §3.3 第 4 条）：切回地图、镜头飞到该地点、打开详情卡。
  // 只对有坐标且未隐藏的条目可用。选中状态的清理与 resetOverview 一致，但不递增 globeResetVersion。
  const viewOnMap = (entry: CollectionEntry) => {
    if (!entry.location || entry.hidden) return

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
    setSidebarsOpen(true)
    changePrimaryPage('map')
  }

  // 转换成功、刷新之前（PR9 规格 §2 第 8 条）：把视图状态写成 Map 页并选中新国家与新城市，
  // 刷新后直接落在这座城市上。刷新时的视图恢复会校验这些 id（cityById / countryById / journeyDays），
  // 万一某个 id 在新数据里不存在，就回落到总览，不会选中一个不存在的地点。
  // 足迹图层被关掉时一并打开，否则选中的新城市在地图上没有标记（与「在地图上查看」打开想去图层同理）。
  const rememberConvertedPlace = (result: LocalConvertToTravelResult) => {
    const savedLayerVisibility = getInitialLayerVisibility()
    if (savedLayerVisibility[TRAVEL_LAYER_ID] === false) {
      rememberLayerVisibility({ ...savedLayerVisibility, [TRAVEL_LAYER_ID]: true })
    }
    rememberAtlasViewState({
      selectedCountryId: result.countryId,
      selectedCityId: result.cityId,
      selectedDayId: result.travelRecordId,
      selectionMode: 'city',
      globeDistance: cityDistance,
      activePage: 'map',
      pageBeforeUpdate: 'map',
      journeyViewMode,
      activeDroneMediaCityId: undefined,
      activeDroneMediaItemId: undefined,
      sidebarsOpen: true,
    })
  }

  const selectDroneMedia = (cityId: CityId) => {
    const city = cityById[cityId]
    if (!city || !hasDroneMedia(cityId)) return

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

  const selectDay = (day: JourneyDay) => {
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

  return (
    <main className="theme-night relative h-[100dvh] overflow-hidden bg-[#010409] text-slate-950">
      <div className="app-background fixed inset-0 -z-10" />
      <div className="app-grid fixed inset-0 -z-10" />
      <div className="star-field fixed inset-0 -z-10" />
      <AtlasHeader activePage={activePage} onPageChange={changePrimaryPage} scrolled={pageScrolled} />
      <section
        className="atlas-experience cesium-lab-page relative h-[100dvh] w-screen overflow-hidden"
        data-page={activePage}
        data-sidebars-open={sidebarsOpen}
        onScrollCapture={syncPageScrolled}
      >
          <div className="absolute inset-0 z-0">
            <CesiumAtlasGlobe
              hoveredCountryId={hoveredCountryId}
              imageryBrightness={imageryTuning.brightness}
              imageryContrast={imageryTuning.contrast}
              imagerySaturation={imageryTuning.saturation}
              mapSource={mapSource}
              showCity3DTiles={city3DEnabled}
              showLabelsOverlay={mapLabelsEnabled}
              selectedCountryId={selectedCountryId}
              selectedCityId={selectedCityId}
              overviewTarget={overviewTarget}
              selectedCity={selectedCityFocus}
              selectedCountry={selectedCountryFocus}
              selectionMode={selectionMode}
              globeScale={globeDistance}
              resetVersion={globeResetVersion}
              isNight={activeTheme === 'night'}
              showMapContent={activePage === 'map'}
              layerData={layerData}
              activeDroneMediaCityId={activeDroneMediaCityId}
              activeDroneMediaItemId={activeDroneMediaItemId}
              onSelectCity={selectCity}
              onSelectWantToGoPlace={selectWantToGoPlace}
              onSelectDroneMediaItem={selectDroneMediaItem}
              focusPlace={mapFocusPlace}
            />
          </div>

          <div className="pointer-events-none absolute inset-0 z-20">
            <div
              className="atlas-overlay-frame absolute bottom-0"
              data-page={activePage}
              data-sidebars-open={sidebarsOpen}
            >
              <CountrySelector
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
                onSelectCity={selectCity}
                onSelectDroneMedia={selectDroneMedia}
                onDistanceChange={changeGlobeDistance}
                onResetView={resetOverview}
              />

              <div
                className={`atlas-right-stack ${
                  shouldShowDronePanel ? 'atlas-right-stack-with-drone' : ''
                }`}
              >
                {selectedWantToGoEntityId ? (
                  <WantToGoCard
                    key={`want-to-go-${selectedWantToGoEntityId}`}
                    entityId={selectedWantToGoEntityId}
                    onClose={() => setSelectedWantToGoEntityId(undefined)}
                    onConvertToTravel={setConvertTarget}
                  />
                ) : null}

                <InfoCard
                  key={`info-${selectionMode}-${selectedCountryId ?? 'none'}-${selectedCityId ?? 'none'}`}
                  mode={selectionMode}
                  selectedCountryId={selectedCountryId}
                  selectedCityId={selectedCityId}
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

                <MouseControlGuide language="zh" />
              </div>

            </div>
          </div>

          <div className="atlas-map-controls">
            <button
              type="button"
              className="atlas-dock-button atlas-sidebars-toggle pointer-events-auto"
              aria-pressed={sidebarsOpen}
              aria-label={sidebarsOpen ? 'Hide both sidebars' : 'Show both sidebars'}
              title={sidebarsOpen ? '隐藏侧边栏' : '显示侧边栏'}
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
            <div className="atlas-journey-scroll selector-scrollbar h-full overflow-y-auto overscroll-contain">
              <div className="atlas-journey-shell mx-auto w-full max-w-7xl px-5 pb-20 sm:px-8">
                <section className="journey-command-panel">
                  <div className="journey-command-copy">
                    <p className="journey-kicker">Travel chronology</p>
                    <h2>Places, in the order they became memories.</h2>
                    <p>
                      A living index of visited cities, arranged from the newest journey backwards.
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
                </section>

                {journeyViewMode === 'timeline' ? (
                  <Timeline
                    selectedDayId={selectedDayId}
                    onSelectDay={selectDay}
                    onHoverCity={setHoverCityId}
                  />
                ) : (
                  <JourneyYearCards />
                )}
              </div>
            </div>
          </div>

          <div
            ref={collectionStageRef}
            className="atlas-collection-stage absolute inset-0 z-30"
            aria-hidden={activePage !== 'collection'}
          >
            <CollectionPage
              entries={collectionEntries}
              onViewOnMap={viewOnMap}
              onAddWantToGo={() => setIsAddWantToGoOpen(true)}
              onConvertToTravel={setConvertTarget}
            />
          </div>

          <div
            ref={updateStageRef}
            className="atlas-update-stage absolute inset-0 z-30"
            aria-hidden={activePage !== 'about'}
          >
            <ReleaseUpdatePage state={releaseUpdates} />
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
        <CityPhotoGalleryModal
          {...cityPhotoGallery}
          onClose={() => setCityPhotoGallery(undefined)}
        />
      ) : null}

      {/* FR-PUB-2 / AC-10：公开构建不挂载添加对话框与转换对话框。 */}
      {localEditorAvailable ? (
        <WantToGoAddDialog
          open={isAddWantToGoOpen}
          onClose={() => setIsAddWantToGoOpen(false)}
        />
      ) : null}
      {localEditorAvailable ? (
        <ConvertToTravelDialog
          target={convertTarget}
          onClose={() => setConvertTarget(undefined)}
          onConverted={rememberConvertedPlace}
        />
      ) : null}
    </main>
  )
}

export default App
