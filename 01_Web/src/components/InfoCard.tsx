import { LocalEditorError, editorErrorNotice } from '../i18n/editorErrors.ts'
import { usePlaceNames } from '../i18n/usePlaceNames'
import { useLocalizedNotice } from '../i18n/useLocalizedNotice'
import { useTranslation } from 'react-i18next'
import { useCallback, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { CalendarDays, Compass, GripVertical, Layers3, Star, X } from 'lucide-react'
import { localEditorAvailable, useTravelAtlasEditorState } from '../data/editorState'
import { getMediaSource, useMediaCatalog } from '../data/mediaCatalog'
import { addLocalTravelRecord, applyLocalViewOperations, deleteHiddenLocalMedia, journeyChoiceCandidatesOf, placeChoiceCandidatesOf, searchLocalCities } from '../data/localEditorClient'
import { once, useDraft } from '../data/drafts'
import { cityListProbe, photoListProbe } from '../data/draftProbes'
import { placeChoiceKey, placeChoiceStateOf, type PlaceChoiceState } from '../data/placeChoice.ts'
import { journeyChoiceInput, journeyChoiceKey, journeyChoiceStateOf, type JourneyChoiceState } from '../data/journeyChoice.ts'
import { cityDraftOperations, hideIdsOperation, photoDraftOperations, restoreHiddenOperation } from '../data/editorStateDelta'
import type { CitySearchOption } from '../data/localEditorApi'
import { useTravelAtlas } from '../data/travelAtlas'
import type { CityId, Country, CountryId, SelectionMode, TravelMapRecord } from '../types/travel'
import type { CityPhotoGalleryRequest } from './CityPhotoGalleryModal'
import { LocationSearchField } from './LocationSearchField'
import { PlaceChoiceList } from './PlaceChoiceList'
import { JourneyChoiceList } from './JourneyChoiceList'
import { LocalEditorToolbar } from './LocalEditorToolbar'
import { MediaRecoveryEntry } from './MediaRecoveryEntry'
import { MediaMaintenanceEntry } from './MediaMaintenanceEntry'
import { requestMediaRecovery } from '../data/mediaRecoveryUi.ts'
import { CityWantToGoAction } from './CityWantToGoAction'
import { DraftConflictNotice } from './DraftConflictNotice'
import { useFlipLayout } from './useFlipLayout'
import { useMediaJobs } from './useMediaJobs'
import { isFinishedMediaJob } from '../data/mediaJobs'
import { useLocalEditorCoordination } from './useLocalEditorCoordination'
import { activateOnKey } from './keyboardActivation.ts'
import type { DateEvidence } from '../worldgraph/timeFilter'
import { formatRecordDate, formatRecordDateSummary } from '../data/derive/recordDateLabel'
import { continentOfCountry } from '../data/continents'

type InfoCardProps = {
  mode: SelectionMode
  selectedCountryId?: CountryId
  selectedCityId?: CityId
  matchingTravelRecordIds?: readonly string[]
  matchingCountryVisitDates?: readonly DateEvidence[]
  outsideTimeFilter?: boolean
  onClearTimeFilter?: () => void
  onSelectCity?: (cityId: CityId) => void
  onOpenCityPhotos?: (request: CityPhotoGalleryRequest) => void
}

const getContinentName = (country?: Country) => continentOfCountry(country) ?? '—'

export function InfoCard({ mode, selectedCountryId, selectedCityId, matchingTravelRecordIds, matchingCountryVisitDates, outsideTimeFilter = false, onClearTimeFilter, onSelectCity, onOpenCityPhotos }: InfoCardProps) {
  const { t } = useTranslation(['details', 'editor', 'journey'])
  const { name, subtitle } = usePlaceNames()
  const { cityById, countryById, countryIdOfCity, getCitiesForCountry } = useTravelAtlas()
  const travelAtlasEditorState = useTravelAtlasEditorState()
  const { allImportedMediaItems, getCityCoverPhoto, getCityPhotos } = useMediaCatalog()
  const country = selectedCountryId ? countryById[selectedCountryId] : undefined
  const city = selectedCityId ? cityById[selectedCityId] : undefined
  const isCityMode = mode === 'city' && city && country
  const isOverview = mode === 'overview' || !country
  const memoryCities = useMemo(() => country ? getCitiesForCountry(country.id) : [], [country, getCitiesForCountry])
  const matchingRecordIds = useMemo(() => matchingTravelRecordIds === undefined ? undefined : new Set(matchingTravelRecordIds), [matchingTravelRecordIds])
  const browseMemoryCities = useMemo(() => matchingRecordIds === undefined ? memoryCities
    : memoryCities.filter((item) => item.records?.some((record) => matchingRecordIds.has(record.id))), [memoryCities, matchingRecordIds])
  const selectedRecords = isCityMode ? city.records ?? [] : country?.records ?? []
  const matchingVisits = matchingRecordIds === undefined ? selectedRecords : selectedRecords.filter((record) => matchingRecordIds.has(record.id))
  const recordDateWords = { unknown: t('details:unknownDate'), yearOnly: t('journey:yearOnly'), partial: t('details:dateQualitypartial'),
    missing: t('details:dateQualitymissing'), invalid: t('details:dateQualityinvalid') }
  const recordDateLabel = (record: TravelMapRecord) => formatRecordDate(
    { startDate: record.start_date, endDate: record.end_date, year: record.year },
    recordDateWords,
  )
  const summaryDateLabel = (summary: unknown, records: readonly TravelMapRecord[]) => formatRecordDateSummary(summary,
    records.map(record => ({ startDate: record.start_date, endDate: record.end_date, year: record.year })), recordDateWords)
  const countryVisitLabel = (date: DateEvidence) => {
    const label = date.quality === 'valid' && date.range.from && date.range.to
      ? date.precision === 'year' ? date.range.from.slice(0, 4)
        : date.range.from === date.range.to ? date.range.from : `${date.range.from} – ${date.range.to}`
      : t('details:unknownDate')
    return t('details:countryVisitDate', { date: label })
  }
  const matchingDateLabel = (records: readonly TravelMapRecord[]) => records.length > 0
    ? [...new Set(records.map(recordDateLabel))].join(' · ')
    : matchingCountryVisitDates?.length ? matchingCountryVisitDates.map(countryVisitLabel).join(' · ') : t('details:noMatchingVisits')
  const isCountryGrid = mode === 'country' && Boolean(country)
  const cityPhotos = useMemo(() => isCityMode ? getCityPhotos(city.id) : [], [city, isCityMode, getCityPhotos])
  const isCityPhotoGrid = isCityMode && cityPhotos.length > 0
  const usesMemoryGridPreview = isCountryGrid || Boolean(isCityMode)
  const memorySectionLabel = isCityMode ? t('details:cityPhotos') : t('details:cityCards')
  const cityCoverPhoto = useMemo(() => isCityMode ? getCityCoverPhoto(city.id) : undefined, [city, isCityMode, getCityCoverPhoto])
  const photoInputRef = useRef<HTMLInputElement>(null)
  // 3C-5 D: a draft starts when editing starts, from the data on the page then (its baselines and revision), and ends with
  // the save or the exit; without a draft the grids show the data. Saves apply only the difference from the baselines (D1).
  const cityProbe = useMemo(() => cityListProbe(country?.id), [country?.id])
  const photoProbe = useMemo(() => photoListProbe(isCityMode ? city.id : undefined), [isCityMode, city?.id])
  const cityDraft = useDraft(cityProbe)
  const photoDraft = useDraft(photoProbe)
  const cityEditing = cityDraft.active
  const photoEditing = photoDraft.active
  const [showAddCity, setShowAddCity] = useState(false)
  const [editorNotice, setEditorNotice] = useLocalizedNotice()
  const [editorBusy, setEditorBusy] = useState(false)
  const photoImportTarget = isCityMode ? JSON.stringify([country.id, city.id, 'photos']) : undefined
  const mediaSession = useMediaJobs()
  const coordination = useLocalEditorCoordination()
  const photoImportTargetRef = useRef<string | undefined>(undefined)
  useLayoutEffect(() => {
    photoImportTargetRef.current = photoImportTarget
    return () => { photoImportTargetRef.current = undefined }
  }, [photoImportTarget])
  const photoImportLocked = mediaSession.loading || mediaSession.busy || Boolean(mediaSession.error || mediaSession.status)
    || mediaSession.jobs.some(job => !isFinishedMediaJob(job))
  const editorActionBusy = editorBusy || coordination.blocked
  const [draggedCityId, setDraggedCityId] = useState<CityId>()
  const [draggedPhotoId, setDraggedPhotoId] = useState<string>()
  const [draftCityIds, setDraftCityIds] = useState<CityId[]>([])
  const [draftHiddenCityIds, setDraftHiddenCityIds] = useState<CityId[]>([])
  const [draftPhotoIds, setDraftPhotoIds] = useState<string[]>([])
  const [draftHiddenPhotoIds, setDraftHiddenPhotoIds] = useState<string[]>([])
  const [baselineCityOrder, setBaselineCityOrder] = useState<readonly CityId[]>([])
  const [baselineHiddenCityIds, setBaselineHiddenCityIds] = useState<readonly CityId[]>([])
  const [baselinePhotoOrder, setBaselinePhotoOrder] = useState<readonly string[]>([])
  const [baselineHiddenPhotoIds, setBaselineHiddenPhotoIds] = useState<readonly string[]>([])
  const [draftCoverPhotoId, setDraftCoverPhotoId] = useState<string | undefined>()
  const [selectedCityOption, setSelectedCityOption] = useState<CitySearchOption>()
  const [isManualCityEntry, setIsManualCityEntry] = useState(false)
  const [manualCity, setManualCity] = useState({ nameZh: '', nameEn: '', lat: '', lng: '' })
  const [cityVisitDates, setCityVisitDates] = useState({ startDate: '', endDate: '' })
  // 第 2A 批：服务端返回的同名地点候选与用户的选择（属于提交时的输入）。
  const [placeChoice, setPlaceChoice] = useState<PlaceChoiceState>()
  // 第 2C 批：默认行程标题「国家 · 城市」与已有行程相同时，服务端返回的候选行程与用户的选择。
  const [journeyChoice, setJourneyChoice] = useState<JourneyChoiceState>()
  const cityByDraftId = new Map(memoryCities.map((item) => [item.id, item]))
  const photoByDraftId = new Map(cityPhotos.map((item) => [item.id, item]))
  const displayedMemoryCities = cityEditing
    ? draftCityIds.map((id) => cityByDraftId.get(id)).filter(Boolean)
    : browseMemoryCities
  const displayedCityPhotos = photoEditing
    ? draftPhotoIds.map((id) => photoByDraftId.get(id)).filter(Boolean)
    : cityPhotos
  const memoryGridRef = useFlipLayout<HTMLDivElement>(
    isCityMode ? displayedCityPhotos.map((photo) => photo?.id).join('|') : displayedMemoryCities.map((item) => item?.id).join('|'),
  )
  // 被隐藏的城市不在 cityById 里；所属国家只问 countryIdOfCity，不解析 id 的结构（RFC-LOC-1 PR3b-1 §2.5）。
  const hiddenCityIdsForCountry = country
    ? draftHiddenCityIds.filter((id) => countryIdOfCity(id) === country.id)
    : []
  const hiddenPhotoIdsForCity = city
    ? draftHiddenPhotoIds.filter((id) => allImportedMediaItems.some((item) => item.id === id && item.cityId === city.id && item.kind === 'photo'))
    : []
  const countryCode = country?.flagCode
  const searchCityOptions = useCallback((query: string, signal: AbortSignal) => {
    if (!countryCode) return Promise.reject(new LocalEditorError({
      code: 'E_CITY_SEARCH_COUNTRY_CODE_MISSING', error: t('editor:noIso'),
    }))
    return searchLocalCities(query, countryCode, signal)
  }, [countryCode, t])

  /** The city draft from the data on the page now (start, or undo). */
  const startCityDraft = () => {
    cityDraft.begin()
    setDraftCityIds(memoryCities.map((item) => item.id))
    setDraftHiddenCityIds(travelAtlasEditorState.hiddenCityIds)
    setBaselineCityOrder(country ? travelAtlasEditorState.cityOrderByCountry[country.id] ?? [] : [])
    setBaselineHiddenCityIds(travelAtlasEditorState.hiddenCityIds)
  }
  const resetAddCity = () => {
    setShowAddCity(false)
    setSelectedCityOption(undefined)
    setIsManualCityEntry(false)
    setManualCity({ nameZh: '', nameEn: '', lat: '', lng: '' })
    setCityVisitDates({ startDate: '', endDate: '' })
    setPlaceChoice(undefined)
    setJourneyChoice(undefined)
  }
  /** The photo draft from the data on the page now (start, or undo). */
  const startPhotoDraft = () => {
    photoDraft.begin()
    setDraftPhotoIds(cityPhotos.map((photo) => photo.id))
    setDraftHiddenPhotoIds(travelAtlasEditorState.hiddenMediaIds)
    setDraftCoverPhotoId(cityCoverPhoto?.id)
    setBaselinePhotoOrder(isCityMode ? travelAtlasEditorState.mediaOrderByCity[city.id] ?? [] : [])
    setBaselineHiddenPhotoIds(travelAtlasEditorState.hiddenMediaIds)
  }
  // 3C-5 D: a list changed elsewhere while its draft is open: the save waits for the user's choice. Keeping the draft
  // takes the list as it is now as the baseline, so the save writes the draft's order and hidden items over it.
  const cityConflictId = useId()
  const photoConflictId = useId()
  const cityConflict = cityDraft.status === 'changed' || cityDraft.status === 'deleted'
  const photoConflict = photoDraft.status === 'changed' || photoDraft.status === 'deleted'
  const keepCityDraft = () => {
    cityDraft.keepMine()
    setBaselineCityOrder(country ? travelAtlasEditorState.cityOrderByCountry[country.id] ?? [] : [])
    setBaselineHiddenCityIds(travelAtlasEditorState.hiddenCityIds)
    setEditorNotice('')
  }
  const keepPhotoDraft = () => {
    photoDraft.keepMine()
    setBaselinePhotoOrder(isCityMode ? travelAtlasEditorState.mediaOrderByCity[city.id] ?? [] : [])
    setBaselineHiddenPhotoIds(travelAtlasEditorState.hiddenMediaIds)
    setEditorNotice('')
  }
  /** A write of a draft is saved: the page shows the data (3C-5 D: no reload), the editor closes. */
  const draftSaved = (draft: { end(): void }) => {
    draft.end()
    resetAddCity()
    setEditorBusy(false)
    setEditorNotice('')
  }

  const saveCityDraft = async () => {
    if (!country || editorActionBusy) return
    setEditorBusy(true)
    setEditorNotice({ key: 'editor:savingCities' })
    // 3C-5 D: the editor closes in the same render as the saved data (onApplied), once.
    const saved = once(() => draftSaved(cityDraft))
    try {
      await applyLocalViewOperations(cityDraftOperations({
        countryId: country.id, draftCityIds, baselineCityIds: baselineCityOrder, baselineHiddenCityIds, draftHiddenCityIds,
      }), { ...cityDraft.writeOptions(), onApplied: saved })
      saved()
    } catch (error) {
      setEditorNotice(editorErrorNotice(error, 'editor:saveFailed'))
      setEditorBusy(false)
    }
  }

  const savePhotoDraft = async () => {
    if (!city || editorActionBusy) return
    setEditorBusy(true)
    setEditorNotice({ key: 'editor:savingPhotos' })
    const saved = once(() => draftSaved(photoDraft))
    try {
      await applyLocalViewOperations(photoDraftOperations({
        cityId: city.id, draftPhotoIds, baselinePhotoIds: baselinePhotoOrder, baselineHiddenPhotoIds, draftHiddenPhotoIds, draftCoverPhotoId,
      }), { ...photoDraft.writeOptions(), onApplied: saved })
      saved()
    } catch (error) {
      setEditorNotice(editorErrorNotice(error, 'editor:saveFailed'))
      setEditorBusy(false)
    }
  }

  // 这次要提交的城市：手动输入或检索结果。也用来判断同名地点的候选是否仍属于当前输入（第 2A 批）。
  const cityOptionForSubmit = (): CitySearchOption | undefined => isManualCityEntry
    ? {
        id: `manual-${manualCity.nameEn || manualCity.nameZh}`,
        nameZh: manualCity.nameZh.trim(),
        nameEn: (manualCity.nameEn || manualCity.nameZh).trim(),
        countryCode: country?.flagCode ?? '',
        lat: Number(manualCity.lat),
        lng: Number(manualCity.lng),
        detail: '手动坐标',
        provider: 'manual',
      }
    : selectedCityOption
  const submittedCity = cityOptionForSubmit()
  const cityChoiceKey = placeChoiceKey([country?.id, submittedCity?.nameZh, submittedCity?.nameEn, submittedCity?.lat, submittedCity?.lng])
  // 输入变了，原来的候选就作废，重新走一遍流程。
  const activePlaceChoice = placeChoice?.key === cityChoiceKey ? placeChoice : undefined
  // 行程候选属于「城市 + 地点选择」：默认标题取决于选定的城市，所以换了城市或地点选择，候选就作废（第 2C 批）。
  // 服务端先返回地点选择、再返回行程选择，两张列表可能同时显示。
  const cityJourneyKey = journeyChoiceKey([cityChoiceKey, activePlaceChoice?.selected ?? null])
  const activeJourneyChoice = journeyChoice?.key === cityJourneyKey ? journeyChoice : undefined

  const addCity = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!country || editorActionBusy) return
    if (!selectedCityOption && !isManualCityEntry) {
      setEditorNotice({ key: 'editor:chooseCity' })
      return
    }
    const cityOption = submittedCity
    if (
      !cityOption?.nameZh
      || !cityOption.nameEn
      || (isManualCityEntry && (!manualCity.lat.trim() || !manualCity.lng.trim()))
      || !Number.isFinite(cityOption.lat)
      || !Number.isFinite(cityOption.lng)
      || cityOption.lat < -90
      || cityOption.lat > 90
      || cityOption.lng < -180
      || cityOption.lng > 180
    ) {
      setEditorNotice({ key: 'editor:invalidCity' })
      return
    }
    const choice = activePlaceChoice
    if (choice && !choice.selected) {
      setEditorNotice({ key: 'editor:placeChoiceRequired' })
      return
    }
    if (activeJourneyChoice && !activeJourneyChoice.selected) {
      setEditorNotice({ key: 'editor:journeyChoiceRequired' })
      return
    }
    const journey = journeyChoiceInput(activeJourneyChoice?.selected)
    setEditorBusy(true)
    setEditorNotice({ key: 'editor:creatingCity' })
    const dates = { start_date: cityVisitDates.startDate, end_date: cityVisitDates.endDate || undefined }
    try {
      if (choice?.selected?.kind === 'existing') {
        // 用户选定的已有地点：按 id 引用，不再按名字匹配。坐标只在地点没有坐标时补上。
        await addLocalTravelRecord({ placeId: choice.selected.placeId, ...dates, lat: cityOption.lat, lng: cityOption.lng, ...journey })
      } else {
        await addLocalTravelRecord({
          country: country.nameZh,
          country_en: country.nameEn,
          country_code: country.flagCode,
          city: cityOption.nameZh,
          city_en: cityOption.nameEn,
          ...dates,
          lat: cityOption.lat,
          lng: cityOption.lng,
          ...(choice?.selected?.kind === 'new' ? { createNew: true as const } : {}),
          ...journey,
        })
      }
      draftSaved(cityDraft)
    } catch (error) {
      // 409 E_PLACE_CHOICE_REQUIRED：在表单里列出候选，同一按钮再次提交（第 2A 批）。
      const candidates = placeChoiceCandidatesOf(error)
      if (candidates) setPlaceChoice(placeChoiceStateOf(cityChoiceKey, candidates))
      // 409 E_JOURNEY_CHOICE_REQUIRED：默认标题撞上已有行程，列出候选行程，不预选（第 2C 批）。
      const journeys = journeyChoiceCandidatesOf(error)
      if (journeys) setJourneyChoice(journeyChoiceStateOf(cityJourneyKey, journeys))
      setEditorNotice(editorErrorNotice(error, 'editor:createFailed'))
      setEditorBusy(false)
    }
  }

  const uploadPhotos = async (files: FileList | null) => {
    if (!files?.length || !localEditorAvailable || !isCityMode || !country || !city || editorActionBusy || photoImportLocked) return
    const target = photoImportTarget
    const countryId = country.id
    const cityId = city.id
    const isCurrentTarget = () => photoImportTargetRef.current === target
    setEditorBusy(true)
    setEditorNotice({ key: 'editor:receivingPhotos', values: { count: files.length } })
    try {
      await mediaSession.uploadBatch(Array.from(files, file => ({ countryId, cityId, kind: 'photo' as const, file })))
      if (!isCurrentTarget()) return
      setEditorNotice('')
      requestMediaRecovery()
    } catch {
      requestMediaRecovery()
      if (isCurrentTarget()) setEditorNotice('')
    } finally {
      if (isCurrentTarget()) {
        if (photoInputRef.current) photoInputRef.current.value = ''
      }
      setEditorBusy(false)
    }
  }
  const visitedCityCount = matchingRecordIds === undefined ? country?.cityIds.length ?? 0 : browseMemoryCities.length
  const openCityGallery = (galleryMode: CityPhotoGalleryRequest['mode'], initialPhotoId?: string) => {
    if (!isCityPhotoGrid || !city) return
    onOpenCityPhotos?.({
      photos: cityPhotos,
      cityName: name(city),
      cityId: city.id,
      initialPhotoId,
      mode: galleryMode,
    })
  }
  const eyebrowLabel = isOverview ? t('details:overview') : isCityMode ? t('details:cityInfo') : t('details:selectedCountry')
  const title = isOverview ? 'StarMap' : isCityMode ? name(city) : name(country)
  const continent = getContinentName(country)
  const continentName = continent === '—' ? continent : t(`details:continent${continent.replaceAll(' ', '')}`)
  const titleDetail = isOverview
    ? t('details:mapOverview')
    : isCityMode
      ? name(city)
      : name(country)
  const dateLabel = isOverview
    ? t('details:selectPlace')
    : matchingRecordIds !== undefined
      ? matchingDateLabel(matchingVisits)
      : isCityMode
      ? summaryDateLabel(city.visitedDateRange, selectedRecords)
      : summaryDateLabel(country.visitedDateRange, selectedRecords)
  const summary = isOverview
    ? t('details:overviewDescription')
    : isCityMode
      ? city.summary
      : country.summary

  return (
    <aside
      className="atlas-info-panel selector-scrollbar glass-panel pointer-events-auto relative z-10 flex w-full max-w-sm flex-col overflow-hidden p-5 text-left"
      data-memory-layout={usesMemoryGridPreview ? 'grid' : 'track'}
    >
      <div className="atlas-info-header mb-5 flex shrink-0 items-center justify-between gap-3">
        <div className="atlas-panel-body">
          <p className="atlas-card-eyebrow text-xs font-semibold uppercase tracking-[0.24em] text-white">
            {eyebrowLabel}
          </p>
          <h2 className="atlas-card-title mt-2 text-2xl font-semibold tracking-normal text-slate-950">
            {title}
          </h2>
          {!isOverview ? (
            <>
              <p className="mt-1 text-sm font-medium text-slate-600">
                {isCityMode ? subtitle(city) : subtitle(country)}
              </p>
              <p className="mt-2 text-sm font-medium text-white">
                {dateLabel}
              </p>
            </>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <div className="atlas-panel-body grid size-11 place-items-center rounded-full bg-slate-950 text-white shadow-lg">
            <CalendarDays className="size-5" />
          </div>
        </div>
      </div>

      <div className="atlas-info-content atlas-panel-body flex min-h-0 flex-1 flex-col gap-4">
        {outsideTimeFilter && !isOverview ? (
          <div className="atlas-local-editor-notice" role="status" data-time-filter-outside="true">
            <p>{t('details:outsideTimeFilter')}</p>
            {onClearTimeFilter ? <button type="button" onClick={onClearTimeFilter}>{t('details:clearTimeFilter')}</button> : null}
          </div>
        ) : null}
        {matchingRecordIds !== undefined && !isOverview ? (
          <section className="shrink-0 text-sm text-slate-600" aria-label={t('details:matchingVisits', { count: matchingVisits.length })}>
            <p className="font-semibold">{t('details:matchingVisits', { count: matchingVisits.length })}</p>
            {matchingVisits.length > 0 ? (
              <ul className="max-h-32 overflow-y-auto">
                {matchingVisits.map((record) => <li key={record.id} data-travel-record-id={record.id}>
                  {recordDateLabel(record)}{record.trip_title ? ` · ${record.trip_title}` : ''}
                </li>)}
              </ul>
            ) : <p>{t('details:noMatchingVisits')}</p>}
          </section>
        ) : null}
        {matchingCountryVisitDates?.length ? <p className="shrink-0 text-sm">{matchingCountryVisitDates.map(countryVisitLabel).join(' · ')}</p> : null}
        {isCityMode && localEditorAvailable ? (
          <CityWantToGoAction
            key={city.id}
            cityId={city.id}
            disabled={editorActionBusy || cityEditing || photoEditing || showAddCity}
          />
        ) : null}
        {isOverview ? (
          <div>
            <p className="text-sm text-slate-500">
              {dateLabel}
            </p>
            <h3 className="mt-1 text-xl font-semibold tracking-normal text-slate-950">
              {titleDetail}
            </h3>
          </div>
        ) : null}

        {isCityMode ? (
          <div className="atlas-preview-card shrink-0 overflow-hidden rounded-[22px] border border-white/70 bg-white/50 shadow-[0_16px_50px_rgba(15,23,42,0.1)]">
            {cityCoverPhoto ? (
              <img
                src={getMediaSource(cityCoverPhoto, 'thumb')}
                alt={t('details:travelPreview', { name: name(city) })}
                className="h-24 w-full object-cover"
                loading="lazy"
                decoding="async"
              />
            ) : (
              <div
                className="h-24 bg-[radial-gradient(circle_at_22%_22%,rgba(255,255,255,0.95),transparent_24%),linear-gradient(135deg,rgba(14,165,233,0.52),rgba(15,23,42,0.78)),linear-gradient(90deg,rgba(255,255,255,0.24)_1px,transparent_1px)] bg-[length:auto,auto,28px_28px]"
                style={{ backgroundColor: country.accent }}
              />
            )}
            <div className="flex items-center justify-between px-3 py-2">
              <span className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">
                {t('details:previewImage')}</span>
              <span className="text-xs font-medium text-slate-500">{name(city)}</span>
            </div>
          </div>
        ) : null}

        <div className="grid shrink-0 grid-cols-2 gap-3">
          <div className="atlas-info-metric rounded-[18px] border border-white/60 bg-white/55 p-3">
            <p className="text-xs text-slate-400">
              {isOverview ? t('details:mode') : isCityMode ? t('details:country') : t('details:visitedCities')}
            </p>
            <p className="mt-1 text-sm font-semibold text-slate-900">
              {isOverview
                ? t('details:overview')
                : isCityMode
                  ? name(country)
                  : t('details:cityCount', { count: visitedCityCount })}
            </p>
          </div>
          <div className="atlas-info-metric rounded-[18px] border border-white/60 bg-white/55 p-3">
            <p className="text-xs text-slate-400">{isOverview ? t('details:keywords') : t('details:continent')}</p>
            <p className="mt-1 text-sm font-semibold text-slate-900">
              {isOverview ? t('details:overviewKeywords') : continentName}
            </p>
          </div>
        </div>

        {isOverview ? <p className="text-sm leading-6 text-slate-600">{summary}</p> : null}

        {(isCountryGrid || isCityMode) && (
          (isCityMode ? cityPhotos.length > 0 : memoryCities.length > 0) || localEditorAvailable
        ) ? (
          <div
            className={`atlas-memory-panel flex min-h-0 flex-col rounded-[22px] bg-slate-950 p-3 text-white shadow-[0_18px_50px_rgba(15,23,42,0.2)] ${
              usesMemoryGridPreview ? 'atlas-memory-panel-grid-preview' : ''
            }`}
            data-photo-gallery={isCityMode ? 'true' : undefined}
            onClick={isCityPhotoGrid ? () => openCityGallery('grid') : undefined}
          >
            {isCityMode ? (
              <div className="atlas-memory-panel-heading-row mb-3">
                <button
                  type="button"
                  className="atlas-memory-panel-heading flex shrink-0 items-center gap-2"
                  disabled={!isCityPhotoGrid || photoEditing}
                  onClick={(event) => {
                    event.stopPropagation()
                    openCityGallery('grid')
                  }}
                >
                  <Layers3 className="size-4 text-sky-300" />
                  <span className="text-xs uppercase tracking-[0.18em] text-slate-400">
                    {memorySectionLabel}
                  </span>
                </button>
                {localEditorAvailable ? (
                  <LocalEditorToolbar
                    editing={photoEditing}
                    busy={editorActionBusy}
                    label={t('editor:photos')}
                    onToggle={() => {
                      if (editorActionBusy) return
                      if (photoEditing) photoDraft.end()
                      else startPhotoDraft()
                      setEditorNotice('')
                    }}
                    onReset={() => {
                      if (editorActionBusy) return
                      startPhotoDraft()
                      setEditorNotice({ key: 'editor:undoPhotos' })
                    }}
                    onAdd={() => {
                      if (photoImportLocked) { requestMediaRecovery(); return }
                      if (!editorActionBusy) photoInputRef.current?.click()
                    }}
                    onSave={savePhotoDraft}
                    saveBlockedBy={photoConflict ? photoConflictId : undefined}
                  />
                ) : null}
                {/* 上传入口与照片工具栏同一道门：公开模式下不渲染（不靠 sr-only 隐藏）。 */}
                {localEditorAvailable ? (
                  <input
                    ref={photoInputRef}
                    className="sr-only"
                    type="file"
                    accept="image/jpeg,image/png,image/webp,image/avif"
                    multiple
                    disabled={editorActionBusy || photoImportLocked}
                    onChange={(event) => void uploadPhotos(event.currentTarget.files)}
                  />
                ) : null}
              </div>
            ) : (
              <div className="atlas-memory-panel-heading-row mb-3">
                <div className="flex shrink-0 items-center gap-2">
                  <Layers3 className="size-4 text-sky-300" />
                  <p className="text-xs uppercase tracking-[0.18em] text-slate-400">
                    {memorySectionLabel}
                  </p>
                </div>
                {localEditorAvailable ? (
                  <LocalEditorToolbar
                    editing={cityEditing}
                    busy={editorActionBusy}
                    label={t('editor:cities')}
                    onToggle={() => {
                      if (editorActionBusy) return
                      if (cityEditing) cityDraft.end()
                      else startCityDraft()
                      resetAddCity()
                      setEditorNotice('')
                    }}
                    onReset={() => {
                      if (editorActionBusy) return
                      startCityDraft()
                      resetAddCity()
                      setEditorNotice({ key: 'editor:undoCities' })
                    }}
                    onAdd={() => {
                      if (!editorActionBusy) setShowAddCity((open) => !open)
                    }}
                    onSave={saveCityDraft}
                    saveBlockedBy={cityConflict ? cityConflictId : undefined}
                  />
                ) : null}
              </div>
            )}

            {isCountryGrid && cityEditing ? (
              <DraftConflictNotice
                id={cityConflictId}
                status={cityDraft.status}
                before={cityDraft.baseValue}
                after={cityDraft.current}
                busy={editorActionBusy}
                onKeepMine={keepCityDraft}
                onTakeTheirs={() => { startCityDraft(); setEditorNotice('') }}
                onDiscard={() => { cityDraft.end(); resetAddCity() }}
              />
            ) : null}
            {isCityMode && photoEditing ? (
              <DraftConflictNotice
                id={photoConflictId}
                status={photoDraft.status}
                before={photoDraft.baseValue}
                after={photoDraft.current}
                busy={editorActionBusy}
                onKeepMine={keepPhotoDraft}
                onTakeTheirs={() => { startPhotoDraft(); setEditorNotice('') }}
                onDiscard={() => photoDraft.end()}
              />
            ) : null}

            {isCountryGrid && cityEditing && showAddCity ? (
              <form className="atlas-local-editor-form atlas-local-editor-form-dark" onSubmit={addCity} onClick={(event) => event.stopPropagation()}>
                {isManualCityEntry ? (
                  <div className="atlas-local-editor-form-grid">
                    <label className="atlas-local-editor-date-field">
                      <span>{t('editor:cityName')}</span>
                      <input required value={manualCity.nameZh} onChange={(event) => setManualCity((value) => ({ ...value, nameZh: event.target.value }))} />
                    </label>
                    <label className="atlas-local-editor-date-field">
                      <span>{t('editor:englishName')}</span>
                      <input value={manualCity.nameEn} onChange={(event) => setManualCity((value) => ({ ...value, nameEn: event.target.value }))} />
                    </label>
                    <label className="atlas-local-editor-date-field">
                      <span>{t('editor:latitudeRange')}</span>
                      <input required type="number" min="-90" max="90" step="any" value={manualCity.lat} onChange={(event) => setManualCity((value) => ({ ...value, lat: event.target.value }))} />
                    </label>
                    <label className="atlas-local-editor-date-field">
                      <span>{t('editor:longitudeRange')}</span>
                      <input required type="number" min="-180" max="180" step="any" value={manualCity.lng} onChange={(event) => setManualCity((value) => ({ ...value, lng: event.target.value }))} />
                    </label>
                  </div>
                ) : (
                  <LocationSearchField
                    label={t('editor:cityName')}
                    placeholder={t('editor:citySearch')}
                    selected={selectedCityOption}
                    search={searchCityOptions}
                    onSelect={setSelectedCityOption}
                    minQueryLength={2}
                    searchOnSubmit
                    getMeta={(option) => option.detail}
                  />
                )}
                <button
                  type="button"
                  className="atlas-local-editor-mode-toggle"
                  onClick={() => {
                    setIsManualCityEntry((value) => !value)
                    setSelectedCityOption(undefined)
                    setEditorNotice('')
                  }}
                >
                  {isManualCityEntry ? t('editor:onlineSearch') : t('editor:manualSearch')}
                </button>
                <div className="atlas-local-editor-form-grid">
                  <label className="atlas-local-editor-date-field">
                    <span>{t('editor:visitDate')}</span>
                    <input required type="date" value={cityVisitDates.startDate} onChange={(event) => setCityVisitDates((dates) => ({ ...dates, startDate: event.target.value }))} />
                  </label>
                  <label className="atlas-local-editor-date-field">
                    <span>{t('editor:endDate')}</span>
                    <input type="date" min={cityVisitDates.startDate || undefined} value={cityVisitDates.endDate} onChange={(event) => setCityVisitDates((dates) => ({ ...dates, endDate: event.target.value }))} />
                  </label>
                </div>
                {!isManualCityEntry ? (
                  <p className="atlas-local-editor-attribution">
                    {t('editor:searchAttribution')}{' '}
                    <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap contributors</a>{t('editor:attributionEnd')}
                  </p>
                ) : null}
                {activePlaceChoice ? (
                  <PlaceChoiceList
                    candidates={activePlaceChoice.candidates}
                    selected={activePlaceChoice.selected}
                    newPlaceName={submittedCity?.nameZh || submittedCity?.nameEn || ''}
                    disabled={editorActionBusy}
                    onSelect={(selected) => {
                      setPlaceChoice({ ...activePlaceChoice, selected })
                      setEditorNotice('')
                    }}
                  />
                ) : null}
                {activeJourneyChoice ? (
                  <JourneyChoiceList
                    candidates={activeJourneyChoice.candidates}
                    selected={activeJourneyChoice.selected}
                    disabled={editorActionBusy}
                    onSelect={(selected) => {
                      setJourneyChoice({ ...activeJourneyChoice, selected })
                      setEditorNotice('')
                    }}
                  />
                ) : null}
                <button type="submit" disabled={editorActionBusy || (!isManualCityEntry && !selectedCityOption) || Boolean(activePlaceChoice && !activePlaceChoice.selected) || Boolean(activeJourneyChoice && !activeJourneyChoice.selected)}>{t('editor:confirmCity')}</button>
              </form>
            ) : null}

            {editorNotice ? <p className="atlas-local-editor-notice atlas-local-editor-notice-dark" role="status">{editorNotice}</p> : null}

            {localEditorAvailable && coordination.blocked ? (
              <p className="atlas-local-editor-notice atlas-local-editor-notice-dark" role="status">
                {t(coordination.otherWriting ? 'mediaImport:otherWriting' : 'mediaImport:otherPending')}
              </p>
            ) : null}

            {localEditorAvailable && isCityMode ? (
              <MediaRecoveryEntry countryId={country.id} cityId={city.id} />
            ) : null}
            {/* 3C-5 F: re-reading this city's descriptions and re-importing its deleted photos (not while its photos are edited). */}
            {import.meta.env.DEV && localEditorAvailable && isCityMode && !photoEditing ? (
              <MediaMaintenanceEntry cityId={city.id} cityName={name(city)} />
            ) : null}

            {isCountryGrid && cityEditing && hiddenCityIdsForCountry.length > 0 ? (
              <button
                type="button"
                className="atlas-local-editor-restore"
                disabled={editorActionBusy}
                onClick={(event) => {
                  event.stopPropagation()
                  if (editorActionBusy) return
                  setEditorBusy(true)
                  // Only the cities listed here; a city hidden elsewhere after this page loaded stays hidden (D1).
                  const saved = once(() => draftSaved(cityDraft))
                  void applyLocalViewOperations([restoreHiddenOperation('cities', hiddenCityIdsForCountry)], { ...cityDraft.writeOptions(), onApplied: saved }).then(saved).catch((error: unknown) => {
                    setEditorNotice(editorErrorNotice(error, 'editor:restoreFailed'))
                    setEditorBusy(false)
                  })
                }}
              >
                {t('editor:restoreCities', { count: hiddenCityIdsForCountry.length })}
              </button>
            ) : null}

            {isCityMode && photoEditing && hiddenPhotoIdsForCity.length > 0 ? (
              <div className="atlas-local-editor-hidden-actions">
                <button
                  type="button"
                  className="atlas-local-editor-restore"
                  disabled={editorActionBusy}
                  onClick={(event) => {
                    event.stopPropagation()
                    if (editorActionBusy) return
                    setEditorBusy(true)
                    const saved = once(() => draftSaved(photoDraft))
                    void applyLocalViewOperations([restoreHiddenOperation('media', hiddenPhotoIdsForCity)], { ...photoDraft.writeOptions(), onApplied: saved }).then(saved).catch((error: unknown) => {
                      setEditorNotice(editorErrorNotice(error, 'editor:restoreFailed'))
                      setEditorBusy(false)
                    })
                  }}
                >
                  {t('editor:restorePhotos', { count: hiddenPhotoIdsForCity.length })}
                </button>
                <button
                  type="button"
                  className="atlas-local-editor-delete"
                  disabled={editorActionBusy || photoImportLocked}
                  onClick={(event) => {
                    event.stopPropagation()
                    if (editorActionBusy || photoImportLocked) return
                    const confirmed = window.confirm(t('editor:deletePhotosConfirm', { count: hiddenPhotoIdsForCity.length }))
                    if (!confirmed) return
                    setEditorBusy(true)
                    setEditorNotice({ key: 'editor:deletingPhotos' })
                    void applyLocalViewOperations([hideIdsOperation('media', hiddenPhotoIdsForCity)], photoDraft.writeOptions())
                      // The second write follows the first one: on the revision of the data on the page now.
                      .then(() => deleteHiddenLocalMedia(city.id, hiddenPhotoIdsForCity))
                      .then(() => draftSaved(photoDraft))
                      .catch((error: unknown) => {
                        setEditorNotice(editorErrorNotice(error, 'editor:deletePermanentlyFailed'))
                        setEditorBusy(false)
                      })
                  }}
                >
                  {t('editor:deletePhotos')}</button>
              </div>
            ) : null}

            {isCityMode && displayedCityPhotos.length === 0 ? (
              <div className="atlas-local-editor-empty">{t('editor:emptyPhotos')}</div>
            ) : null}
            <div
              ref={memoryGridRef}
              className={`atlas-memory-track selector-scrollbar min-h-0 gap-3 overflow-auto pb-2 ${
                usesMemoryGridPreview ? 'atlas-memory-grid-preview' : 'flex snap-x'
              }`}
            >
              {isCityMode ? displayedCityPhotos.map((photo, index) => {
                if (!photo) return null
                // Mouse and keyboard run the same handlers on the photo tools below.
                const makeCover = () => setDraftCoverPhotoId(photo.id)
                const hidePhoto = () => {
                  setDraftPhotoIds((current) => current.filter((id) => id !== photo.id))
                  setDraftHiddenPhotoIds((current) => [...new Set([...current, photo.id])])
                  // A hidden photo cannot stay the city cover.
                  if (draftCoverPhotoId === photo.id) setDraftCoverPhotoId(undefined)
                }
                return (
                <button
                  type="button"
                  key={photo.id}
                  data-flip-id={photo.id}
                  className="city-photo-card"
                  data-editing={photoEditing}
                  data-dragging={draggedPhotoId === photo.id}
                  draggable={photoEditing}
                  aria-label={t('details:openPhoto', { name: name(city), number: index + 1 })}
                  onDragStart={(event) => {
                    if (!photoEditing) return
                    setDraggedPhotoId(photo.id)
                    event.dataTransfer.effectAllowed = 'move'
                    event.dataTransfer.setData('text/plain', photo.id)
                  }}
                  onDragOver={(event) => {
                    if (!photoEditing || !draggedPhotoId || draggedPhotoId === photo.id) return
                    event.preventDefault()
                    setDraftPhotoIds((current) => {
                      const next = current.filter((id) => id !== draggedPhotoId)
                      next.splice(next.indexOf(photo.id), 0, draggedPhotoId)
                      return next
                    })
                  }}
                  onDragEnd={() => setDraggedPhotoId(undefined)}
                  onClick={(event) => {
                    event.stopPropagation()
                    if (!photoEditing) openCityGallery('viewer', photo.id)
                  }}
                >
                  <img
                    src={getMediaSource(photo, 'thumb')}
                    alt={t('details:photoAlt', { name: name(city), number: index + 1 })}
                    loading="lazy"
                    decoding="async"
                  />
                  {photoEditing ? (
                    <span className="atlas-local-media-tools" onClick={(event) => event.stopPropagation()}>
                      <span className="atlas-local-editor-drag" aria-label={t('editor:dragPhotos')}><GripVertical /></span>
                      <span
                        role="button"
                        tabIndex={0}
                        data-active={draftCoverPhotoId === photo.id}
                        aria-label={t('editor:cityCover')}
                        title={t('editor:cityCover')}
                        onClick={makeCover}
                        onKeyDown={(event) => activateOnKey(event, makeCover)}
                      ><Star /></span>
                      <span
                        role="button"
                        tabIndex={0}
                        aria-label={t('editor:hidePhoto')}
                        title={t('editor:hideOriginal')}
                        onClick={hidePhoto}
                        onKeyDown={(event) => activateOnKey(event, hidePhoto)}
                      ><X /></span>
                    </span>
                  ) : null}
                  {draftCoverPhotoId === photo.id ? <span className="atlas-local-cover-badge">{t('editor:cover')}</span> : null}
                </button>
              )}) : displayedMemoryCities.map((memoryCity, index) => {
                if (!memoryCity) return null
                const isActive = memoryCity.id === selectedCityId
                const memoryCoverPhoto = getCityCoverPhoto(memoryCity.id)
                // Mouse and keyboard both ask first on the hide tool below.
                const hideCity = () => {
                  if (!window.confirm(t('editor:hideConfirm', { name: name(memoryCity) }))) return
                  setDraftCityIds((current) => current.filter((id) => id !== memoryCity.id))
                  setDraftHiddenCityIds((current) => [...new Set([...current, memoryCity.id])])
                }

                return (
                  <button
                    type="button"
                    key={memoryCity.id}
                    data-flip-id={memoryCity.id}
                    data-editing={cityEditing}
                    data-dragging={draggedCityId === memoryCity.id}
                    draggable={cityEditing}
                    onDragStart={(event) => {
                      if (!cityEditing) return
                      setDraggedCityId(memoryCity.id)
                      event.dataTransfer.effectAllowed = 'move'
                      event.dataTransfer.setData('text/plain', memoryCity.id)
                    }}
                    onDragOver={(event) => {
                      if (!cityEditing || !draggedCityId || draggedCityId === memoryCity.id) return
                      event.preventDefault()
                      setDraftCityIds((current) => {
                        const next = current.filter((id) => id !== draggedCityId)
                        next.splice(next.indexOf(memoryCity.id), 0, draggedCityId)
                        return next
                      })
                    }}
                    onDragEnd={() => setDraggedCityId(undefined)}
                    onClick={() => {
                      if (!cityEditing) onSelectCity?.(memoryCity.id)
                    }}
                    aria-pressed={isActive}
                    className={`memory-city-card overflow-hidden rounded-[18px] border transition ${
                      usesMemoryGridPreview
                        ? 'memory-city-card-grid-preview min-w-0'
                        : 'min-w-[154px] snap-start'
                    } ${
                      isActive ? 'border-sky-300/90 bg-white/18 shadow-[0_0_34px_rgba(125,211,252,0.2)]' : 'border-white/10 bg-white/10'
                    }`}
                  >
                    {memoryCoverPhoto ? (
                      <img
                        src={getMediaSource(memoryCoverPhoto, 'thumb')}
                        alt={t('details:memoryAlt', { name: name(memoryCity) })}
                        className={`w-full object-cover ${usesMemoryGridPreview ? 'h-[52px]' : 'h-24'}`}
                        loading="lazy"
                        decoding="async"
                      />
                    ) : (
                      <div
                        className={`${usesMemoryGridPreview ? 'h-[52px]' : 'h-24'} bg-[radial-gradient(circle_at_24%_20%,rgba(255,255,255,0.92),transparent_24%),linear-gradient(135deg,rgba(255,255,255,0.24),rgba(15,23,42,0.28)),linear-gradient(120deg,rgba(255,255,255,0.08)_1px,transparent_1px)] bg-[length:auto,auto,22px_22px]`}
                        style={{ backgroundColor: country?.accent ?? '#38bdf8' }}
                      />
                    )}
                    <div className="p-3">
                      {isCountryGrid ? (
                        <div className="memory-city-card-heading">
                          <h4 className="memory-city-card-title text-sm font-semibold text-white">{name(memoryCity)}</h4>
                          <p className="memory-city-card-index text-xs font-medium uppercase tracking-[0.16em] text-slate-400">
                            {String(index + 1).padStart(2, '0')}
                          </p>
                        </div>
                      ) : (
                        <>
                          <p className="memory-city-card-index text-xs font-medium uppercase tracking-[0.16em] text-slate-400">
                            {String(index + 1).padStart(2, '0')}
                          </p>
                          <h4 className="memory-city-card-title mt-1 text-sm font-semibold text-white">{name(memoryCity)}</h4>
                        </>
                      )}
                      <p className="memory-city-card-subtitle text-xs text-slate-300">{subtitle(memoryCity)}</p>
                      <p className="memory-city-card-date mt-2 text-xs leading-5 text-slate-300">
                        {matchingRecordIds !== undefined && !cityEditing
                          ? matchingDateLabel((memoryCity.records ?? []).filter((record) => matchingRecordIds.has(record.id)))
                          : summaryDateLabel(memoryCity.visitedDateRange, memoryCity.records ?? [])}
                      </p>
                    </div>
                    {cityEditing ? (
                      <span className="atlas-local-media-tools atlas-local-city-tools" onClick={(event) => event.stopPropagation()}>
                        <span className="atlas-local-editor-drag" aria-label={t('editor:dragCities')}><GripVertical /></span>
                        <span
                          role="button"
                          tabIndex={0}
                          aria-label={t('editor:hideFor', { name: name(memoryCity) })}
                          title={t('editor:hideRecords')}
                          onClick={hideCity}
                          onKeyDown={(event) => activateOnKey(event, hideCity)}
                        ><X /></span>
                      </span>
                    ) : null}
                  </button>
                )
              })}
            </div>
          </div>
        ) : null}

        <div className="flex shrink-0 items-center gap-2 text-xs font-medium text-slate-500">
          <Compass className="size-4" />
          {t('details:focus', { name: isOverview ? t('details:worldOverview') : isCityMode ? name(city) : name(country) })}
        </div>
      </div>
    </aside>
  )
}
