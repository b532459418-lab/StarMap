import { editorErrorNotice } from '../i18n/editorErrors.ts'
import { usePlaceNames } from '../i18n/usePlaceNames'
import { useLocalizedNotice } from '../i18n/useLocalizedNotice'
import { useTranslation } from 'react-i18next'
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { CalendarDays, Compass, GripVertical, Layers3, Star, X } from 'lucide-react'
import { localEditorAvailable, travelAtlasEditorState } from '../data/editorState'
import { allImportedMediaItems, getCityCoverPhoto, getCityPhotos, getMediaSource } from '../data/mediaCatalog'
import { addLocalTravelRecord, deleteHiddenLocalMedia, importLocalMedia, reloadAfterLocalSave, searchLocalCities, updateLocalEditorState, uploadLocalMedia } from '../data/localEditorApi'
import type { CitySearchOption } from '../data/localEditorApi'
import { cityById, countryById, countryIdOfCity, getCitiesForCountry } from '../data/travelAtlas'
import type { CityId, Country, CountryId, SelectionMode } from '../types/travel'
import type { CityPhotoGalleryRequest } from './CityPhotoGalleryModal'
import { LocationSearchField } from './LocationSearchField'
import { LocalEditorToolbar } from './LocalEditorToolbar'
import { MediaImportRecovery } from './MediaImportRecovery'
import { useFlipLayout } from './useFlipLayout'
import { useMediaImportSession } from './useMediaImportSession'

type InfoCardProps = {
  mode: SelectionMode
  selectedCountryId?: CountryId
  selectedCityId?: CityId
  onSelectCity?: (cityId: CityId) => void
  onOpenCityPhotos?: (request: CityPhotoGalleryRequest) => void
}

const continentRules: Array<{ continent: string; regions: string[] }> = [
  { continent: 'North America', regions: ['north america', '北美', '中美', '加勒比'] },
  { continent: 'South America', regions: ['south america', '南美'] },
  { continent: 'Europe', regions: ['europe', '欧洲', '北欧', '东欧', '西欧', '南欧', '欧亚'] },
  { continent: 'Asia', regions: ['asia', '亚洲', '东亚', '东南亚', '南亚', '中亚', '西亚', '中东', '印度洋'] },
  { continent: 'Africa', regions: ['africa', '非洲', '北非', '东非', '西非', '南非'] },
  { continent: 'Oceania', regions: ['oceania', '大洋洲', '澳洲'] },
  { continent: 'Antarctica', regions: ['antarctica', '南极'] },
]

const getContinentName = (country?: Country) => {
  const regionText = [
    ...(country?.keywords ?? []),
    ...(country?.records?.map((record) => record.region).filter(Boolean) ?? []),
  ]
    .join(' ')
    .toLowerCase()

  return continentRules.find(({ regions }) => regions.some((region) => regionText.includes(region)))?.continent ?? '—'
}

export function InfoCard({ mode, selectedCountryId, selectedCityId, onSelectCity, onOpenCityPhotos }: InfoCardProps) {
  const { t } = useTranslation(['details', 'editor', 'journey'])
  const { name, subtitle } = usePlaceNames()
  const country = selectedCountryId ? countryById[selectedCountryId] : undefined
  const city = selectedCityId ? cityById[selectedCityId] : undefined
  const isCityMode = mode === 'city' && city && country
  const isOverview = mode === 'overview' || !country
  const memoryCities = useMemo(() => country ? getCitiesForCountry(country.id) : [], [country])
  const isCountryGrid = mode === 'country' && Boolean(country)
  const cityPhotos = useMemo(() => isCityMode ? getCityPhotos(city.id) : [], [city, isCityMode])
  const isCityPhotoGrid = isCityMode && cityPhotos.length > 0
  const usesMemoryGridPreview = isCountryGrid || Boolean(isCityMode)
  const memorySectionLabel = isCityMode ? t('details:cityPhotos') : t('details:cityCards')
  const cityCoverPhoto = useMemo(() => isCityMode ? getCityCoverPhoto(city.id) : undefined, [city, isCityMode])
  const photoInputRef = useRef<HTMLInputElement>(null)
  const [cityEditing, setCityEditing] = useState(false)
  const [photoEditing, setPhotoEditing] = useState(false)
  const [showAddCity, setShowAddCity] = useState(false)
  const [editorNotice, setEditorNotice] = useLocalizedNotice()
  const [editorBusy, setEditorBusy] = useState(false)
  const photoImportTarget = isCityMode ? JSON.stringify([country.id, city.id, 'photos']) : undefined
  const mediaSession = useMediaImportSession(photoImportTarget)
  const photoImportTargetRef = useRef<string | undefined>(undefined)
  useLayoutEffect(() => {
    photoImportTargetRef.current = photoImportTarget
    return () => { photoImportTargetRef.current = undefined }
  }, [photoImportTarget])
  const photoImportLocked = mediaSession.state.phase !== 'idle'
  const editorActionBusy = editorBusy || photoImportLocked
  const [draggedCityId, setDraggedCityId] = useState<CityId>()
  const [draggedPhotoId, setDraggedPhotoId] = useState<string>()
  const [draftCityIds, setDraftCityIds] = useState<CityId[]>(memoryCities.map((item) => item.id))
  const [draftHiddenCityIds, setDraftHiddenCityIds] = useState<CityId[]>(travelAtlasEditorState.hiddenCityIds)
  const [draftPhotoIds, setDraftPhotoIds] = useState<string[]>(cityPhotos.map((item) => item.id))
  const [draftHiddenPhotoIds, setDraftHiddenPhotoIds] = useState<string[]>(travelAtlasEditorState.hiddenMediaIds)
  const [draftCoverPhotoId, setDraftCoverPhotoId] = useState<string | undefined>(cityCoverPhoto?.id)
  const [selectedCityOption, setSelectedCityOption] = useState<CitySearchOption>()
  const [isManualCityEntry, setIsManualCityEntry] = useState(false)
  const [manualCity, setManualCity] = useState({ nameZh: '', nameEn: '', lat: '', lng: '' })
  const [cityVisitDates, setCityVisitDates] = useState({ startDate: '', endDate: '' })
  const cityByDraftId = new Map(memoryCities.map((item) => [item.id, item]))
  const photoByDraftId = new Map(cityPhotos.map((item) => [item.id, item]))
  const displayedMemoryCities = cityEditing
    ? draftCityIds.map((id) => cityByDraftId.get(id)).filter(Boolean)
    : memoryCities
  const displayedCityPhotos = photoEditing
    ? draftPhotoIds.map((id) => photoByDraftId.get(id)).filter(Boolean)
    : cityPhotos
  const memoryGridRef = useFlipLayout<HTMLDivElement>(
    isCityMode ? draftPhotoIds.join('|') : draftCityIds.join('|'),
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
    if (!countryCode) return Promise.reject(new Error(t('editor:noIso')))
    return searchLocalCities(query, countryCode, signal)
  }, [countryCode, t])

  const saveCityDraft = async () => {
    if (!country || editorActionBusy) return
    setEditorBusy(true)
    setEditorNotice({ key: 'editor:savingCities' })
    try {
      await updateLocalEditorState((current) => ({
        ...current,
        cityOrderByCountry: { ...current.cityOrderByCountry, [country.id]: draftCityIds },
        hiddenCityIds: draftHiddenCityIds,
      }))
      reloadAfterLocalSave()
    } catch (error) {
      setEditorNotice(editorErrorNotice(error, 'editor:saveFailed'))
      setEditorBusy(false)
    }
  }

  const savePhotoDraft = async () => {
    if (!city || editorActionBusy) return
    setEditorBusy(true)
    setEditorNotice({ key: 'editor:savingPhotos' })
    try {
      await updateLocalEditorState((current) => ({
        ...current,
        mediaOrderByCity: { ...current.mediaOrderByCity, [city.id]: draftPhotoIds },
        hiddenMediaIds: draftHiddenPhotoIds,
        coverMediaByCity: draftCoverPhotoId
          ? { ...current.coverMediaByCity, [city.id]: draftCoverPhotoId }
          : current.coverMediaByCity,
      }))
      reloadAfterLocalSave()
    } catch (error) {
      setEditorNotice(editorErrorNotice(error, 'editor:saveFailed'))
      setEditorBusy(false)
    }
  }

  const addCity = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!country || editorActionBusy) return
    if (!selectedCityOption && !isManualCityEntry) {
      setEditorNotice({ key: 'editor:chooseCity' })
      return
    }
    const manualLat = Number(manualCity.lat)
    const manualLng = Number(manualCity.lng)
    const cityOption: CitySearchOption | undefined = isManualCityEntry
      ? {
          id: `manual-${manualCity.nameEn || manualCity.nameZh}`,
          nameZh: manualCity.nameZh.trim(),
          nameEn: (manualCity.nameEn || manualCity.nameZh).trim(),
          countryCode: country.flagCode ?? '',
          lat: manualLat,
          lng: manualLng,
          detail: '手动坐标',
          provider: 'manual',
        }
      : selectedCityOption
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
    setEditorBusy(true)
    setEditorNotice({ key: 'editor:creatingCity' })
    try {
      await addLocalTravelRecord({
        country: country.nameZh,
        country_en: country.nameEn,
        country_code: country.flagCode,
        city: cityOption.nameZh,
        city_en: cityOption.nameEn,
        start_date: cityVisitDates.startDate,
        end_date: cityVisitDates.endDate || undefined,
        lat: cityOption.lat,
        lng: cityOption.lng,
      })
      reloadAfterLocalSave()
    } catch (error) {
      setEditorNotice(editorErrorNotice(error, 'editor:createFailed'))
      setEditorBusy(false)
    }
  }

  const uploadPhotos = async (files: FileList | null) => {
    if (!files?.length || !localEditorAvailable || !isCityMode || !country || !city || editorActionBusy) return
    const target = photoImportTarget
    const countryId = country.id
    const cityId = city.id
    const isCurrentTarget = () => photoImportTargetRef.current === target
    setEditorBusy(true)
    setEditorNotice({ key: 'editor:receivingPhotos', values: { count: files.length } })
    try {
      await mediaSession.upload(Array.from(files), (file) => uploadLocalMedia({ countryId, cityId, kind: 'photo', file }))
      if (!isCurrentTarget()) return
      setEditorNotice({ key: 'editor:importingPhotos' })
      await mediaSession.importMedia(importLocalMedia)
      if (isCurrentTarget()) reloadAfterLocalSave()
    } catch {
      if (isCurrentTarget()) setEditorNotice('')
    } finally {
      if (isCurrentTarget()) {
        if (photoInputRef.current) photoInputRef.current.value = ''
        setEditorBusy(false)
      }
    }
  }
  const retryPhotoImport = async () => {
    if (editorBusy || mediaSession.state.phase !== 'pending') return
    const target = photoImportTarget
    const isCurrentTarget = () => photoImportTargetRef.current === target
    setEditorBusy(true)
    setEditorNotice({ key: 'editor:importingPhotos' })
    try {
      await mediaSession.importMedia(importLocalMedia)
      if (isCurrentTarget()) reloadAfterLocalSave()
    } catch {
      if (isCurrentTarget()) setEditorNotice('')
    } finally {
      if (isCurrentTarget()) setEditorBusy(false)
    }
  }
  const visitedCityCount = country?.cityIds.length ?? 0
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
    : isCityMode
      ? city.visitedDateRange
      : country.visitedDateRange
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
                {isCityMode ? city.visitedDateRange : country.visitedDateRange}
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
                      setPhotoEditing((editing) => !editing)
                      setDraftPhotoIds(cityPhotos.map((photo) => photo.id))
                      setDraftHiddenPhotoIds(travelAtlasEditorState.hiddenMediaIds)
                      setDraftCoverPhotoId(cityCoverPhoto?.id)
                      setEditorNotice('')
                    }}
                    onReset={() => {
                      if (editorActionBusy) return
                      setDraftPhotoIds(cityPhotos.map((photo) => photo.id))
                      setDraftHiddenPhotoIds(travelAtlasEditorState.hiddenMediaIds)
                      setDraftCoverPhotoId(cityCoverPhoto?.id)
                      setEditorNotice({ key: 'editor:undoPhotos' })
                    }}
                    onAdd={() => {
                      if (!editorActionBusy) photoInputRef.current?.click()
                    }}
                    onSave={savePhotoDraft}
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
                    disabled={editorActionBusy}
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
                      setCityEditing((editing) => !editing)
                      setDraftCityIds(memoryCities.map((item) => item.id))
                      setDraftHiddenCityIds(travelAtlasEditorState.hiddenCityIds)
                      setShowAddCity(false)
                      setSelectedCityOption(undefined)
                      setIsManualCityEntry(false)
                      setManualCity({ nameZh: '', nameEn: '', lat: '', lng: '' })
                      setCityVisitDates({ startDate: '', endDate: '' })
                      setEditorNotice('')
                    }}
                    onReset={() => {
                      setDraftCityIds(memoryCities.map((item) => item.id))
                      setDraftHiddenCityIds(travelAtlasEditorState.hiddenCityIds)
                      setShowAddCity(false)
                      setSelectedCityOption(undefined)
                      setCityVisitDates({ startDate: '', endDate: '' })
                      setEditorNotice({ key: 'editor:undoCities' })
                    }}
                    onAdd={() => setShowAddCity((open) => !open)}
                    onSave={saveCityDraft}
                  />
                ) : null}
              </div>
            )}

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
                <button type="submit" disabled={editorActionBusy || (!isManualCityEntry && !selectedCityOption)}>{t('editor:confirmCity')}</button>
              </form>
            ) : null}

            {editorNotice ? <p className="atlas-local-editor-notice atlas-local-editor-notice-dark" role="status">{editorNotice}</p> : null}

            {localEditorAvailable && isCityMode ? (
              <MediaImportRecovery state={mediaSession.state} busy={editorBusy} onRetry={retryPhotoImport} />
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
                  void updateLocalEditorState((current) => ({
                    ...current,
                    hiddenCityIds: current.hiddenCityIds.filter((id) => countryIdOfCity(id) !== country?.id),
                  })).then(reloadAfterLocalSave).catch((error: unknown) => {
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
                    void updateLocalEditorState((current) => ({
                      ...current,
                      hiddenMediaIds: current.hiddenMediaIds.filter((id) => !hiddenPhotoIdsForCity.includes(id)),
                    })).then(reloadAfterLocalSave).catch((error: unknown) => {
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
                  disabled={editorActionBusy}
                  onClick={(event) => {
                    event.stopPropagation()
                    if (editorActionBusy) return
                    const confirmed = window.confirm(t('editor:deletePhotosConfirm', { count: hiddenPhotoIdsForCity.length }))
                    if (!confirmed) return
                    setEditorBusy(true)
                    setEditorNotice({ key: 'editor:deletingPhotos' })
                    void updateLocalEditorState((current) => ({
                      ...current,
                      hiddenMediaIds: [...new Set([...current.hiddenMediaIds, ...hiddenPhotoIdsForCity])],
                    }))
                      .then(() => deleteHiddenLocalMedia(city.id, hiddenPhotoIdsForCity))
                      .then(reloadAfterLocalSave)
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
                        onClick={() => setDraftCoverPhotoId(photo.id)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') setDraftCoverPhotoId(photo.id)
                        }}
                      ><Star /></span>
                      <span
                        role="button"
                        tabIndex={0}
                        aria-label={t('editor:hidePhoto')}
                        title={t('editor:hideOriginal')}
                        onClick={() => {
                          setDraftPhotoIds((current) => current.filter((id) => id !== photo.id))
                          setDraftHiddenPhotoIds((current) => [...new Set([...current, photo.id])])
                          if (draftCoverPhotoId === photo.id) setDraftCoverPhotoId(undefined)
                        }}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            setDraftPhotoIds((current) => current.filter((id) => id !== photo.id))
                            setDraftHiddenPhotoIds((current) => [...new Set([...current, photo.id])])
                          }
                        }}
                      ><X /></span>
                    </span>
                  ) : null}
                  {draftCoverPhotoId === photo.id ? <span className="atlas-local-cover-badge">{t('editor:cover')}</span> : null}
                </button>
              )}) : displayedMemoryCities.map((memoryCity, index) => {
                if (!memoryCity) return null
                const isActive = memoryCity.id === selectedCityId
                const memoryCoverPhoto = getCityCoverPhoto(memoryCity.id)

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
                        {memoryCity.visitedDateRange ?? t('details:travelMemory')}
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
                          onClick={() => {
                            if (!window.confirm(t('editor:hideConfirm', { name: name(memoryCity) }))) return
                            setDraftCityIds((current) => current.filter((id) => id !== memoryCity.id))
                            setDraftHiddenCityIds((current) => [...new Set([...current, memoryCity.id])])
                          }}
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
