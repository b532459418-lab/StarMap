import { editorErrorNotice } from '../i18n/editorErrors.ts'
import { usePlaceNames } from '../i18n/usePlaceNames'
import { useLocalizedNotice } from '../i18n/useLocalizedNotice'
import { useTranslation } from 'react-i18next'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, Drone, GripVertical, MapPin, Plus, RotateCcw, Settings2, SlidersHorizontal, Undo2, X } from 'lucide-react'
import { withoutListedCountries } from '../data/countrySearchFilter'
import { hasDroneMedia } from '../data/droneMedia'
import { localEditorAvailable, travelAtlasEditorState } from '../data/editorState'
import { addLocalCountry, deleteHiddenLocalCountries, reloadAfterLocalSave, searchLocalCountries, updateLocalEditorState } from '../data/localEditorApi'
import type { CountrySearchOption } from '../data/localEditorApi'
import { countries, getCitiesForCountry, shouldHideCityFromNavigation } from '../data/travelAtlas'
import type { CityId, CountryId } from '../types/travel'
import { LocationSearchField } from './LocationSearchField'
import { useFlipLayout } from './useFlipLayout'

type CountrySelectorProps = {
  /** Browsing only. Sorting, hiding, restoring and add checks retain complete inputs. */
  browse?: { countryIds?: readonly string[]; cityIds?: readonly string[] }
  selectedCountryId?: CountryId
  selectedCityId?: CityId
  activeDroneMediaCityId?: CityId
  globeDistance: number
  imageryBrightness: number
  imageryContrast: number
  imagerySaturation: number
  onBrightnessChange: (value: number) => void
  onContrastChange: (value: number) => void
  onHoverCountry: (countryId?: CountryId) => void
  onResetImageryTuning: () => void
  onSaturationChange: (value: number) => void
  onSelectCountry: (countryId: CountryId) => void
  onSelectCity: (cityId: CityId) => void
  onSelectDroneMedia: (cityId: CityId) => void
  onDistanceChange: (distance: number) => void
  onResetView: () => void
}

const scaleLabelForDistance = (distance: number) => {
  if (distance < 1.68) return 'City'
  if (distance < 2.55) return 'Country'
  return 'World'
}

const debugGlobeScaleChange = (value: number) => {
  if (!import.meta.env.DEV) return

  console.debug('[globe-scale-change]', JSON.stringify({
    value,
    label: scaleLabelForDistance(value),
    time: Date.now(),
  }))
}

export function CountrySelector({
  browse,
  selectedCountryId,
  selectedCityId,
  activeDroneMediaCityId,
  globeDistance,
  imageryBrightness,
  imageryContrast,
  imagerySaturation,
  onBrightnessChange,
  onContrastChange,
  onHoverCountry,
  onResetImageryTuning,
  onSaturationChange,
  onSelectCountry,
  onSelectCity,
  onSelectDroneMedia,
  onDistanceChange,
  onResetView,
}: CountrySelectorProps) {
  const { t } = useTranslation(['details', 'editor', 'journey'])
  const { name, subtitle } = usePlaceNames()
  const selectedCountry = selectedCountryId ? countries.find((country) => country.id === selectedCountryId) : undefined
  const committedDistanceRef = useRef(globeDistance)
  const hasDraftDistanceChangeRef = useRef(false)
  const [isImageTuningOpen, setIsImageTuningOpen] = useState(false)
  const [isGlobeScaleOpen, setIsGlobeScaleOpen] = useState(true)
  const defaultCountryIds = (travelAtlasEditorState.countryOrder.length > 0
    ? countries
    : [...countries].reverse()).map((country) => country.id)
  const [isEditingCountries, setIsEditingCountries] = useState(false)
  const [draftCountryIds, setDraftCountryIds] = useState<CountryId[]>(defaultCountryIds)
  const [draftHiddenCountryIds, setDraftHiddenCountryIds] = useState<CountryId[]>(travelAtlasEditorState.hiddenCountryIds)
  const [draggedCountryId, setDraggedCountryId] = useState<CountryId>()
  const [showAddCountry, setShowAddCountry] = useState(false)
  const [editorNotice, setEditorNotice] = useLocalizedNotice()
  const [isSaving, setIsSaving] = useState(false)
  const [selectedCountryOption, setSelectedCountryOption] = useState<CountrySearchOption>()
  const [countryVisitedDate, setCountryVisitedDate] = useState('')
  const countryDragPointerRef = useRef<number | undefined>(undefined)
  const countriesById = new Map(countries.map((country) => [country.id, country]))
  const browseCountryIds = browse?.countryIds === undefined ? undefined : new Set(browse.countryIds)
  const browseCityIds = browse?.cityIds === undefined ? undefined : new Set(browse.cityIds)
  const displayCountries = draftCountryIds.map((id) => countriesById.get(id))
    .filter((country) => country !== undefined && (isEditingCountries || browseCountryIds === undefined || browseCountryIds.has(country.id)))
  const countryListRef = useFlipLayout<HTMLDivElement>(draftCountryIds.join('|'))
  const searchCountryOptions = useCallback(async (query: string, signal: AbortSignal) => {
    const results = await searchLocalCountries(query, signal)
    // 目录候选的 id 是名字 slug，V2 下国家的 id 是地点 UUID：按 id 或国家代码判断「已在列表里」（RFC-LOC-1 PR3b-2）。
    return withoutListedCountries(results, countries)
  }, [])

  const resetCountryDraft = () => {
    setDraftCountryIds(defaultCountryIds)
    setDraftHiddenCountryIds(travelAtlasEditorState.hiddenCountryIds)
    setShowAddCountry(false)
    setSelectedCountryOption(undefined)
    setCountryVisitedDate('')
    setEditorNotice({ key: 'editor:undoNotice' })
  }

  const saveCountryDraft = async () => {
    setIsSaving(true)
    setEditorNotice({ key: 'editor:saving' })
    try {
      await updateLocalEditorState((current) => ({
        ...current,
        countryOrder: draftCountryIds,
        hiddenCountryIds: draftHiddenCountryIds,
      }))
      reloadAfterLocalSave()
    } catch (error) {
      setEditorNotice(editorErrorNotice(error, 'editor:saveFailed'))
      setIsSaving(false)
    }
  }

  const restoreHiddenCountries = async () => {
    if (draftHiddenCountryIds.length === 0) return
    setIsSaving(true)
    try {
      await updateLocalEditorState((current) => ({ ...current, hiddenCountryIds: [] }))
      reloadAfterLocalSave()
    } catch (error) {
      setEditorNotice(editorErrorNotice(error, 'editor:restoreFailed'))
      setIsSaving(false)
    }
  }

  const deleteHiddenCountries = async () => {
    if (draftHiddenCountryIds.length === 0) return
    const confirmed = window.confirm(t('editor:deleteCountriesConfirm', { count: draftHiddenCountryIds.length }))
    if (!confirmed) return
    setIsSaving(true)
    setEditorNotice({ key: 'editor:deletingCountries' })
    try {
      await updateLocalEditorState((current) => ({
        ...current,
        hiddenCountryIds: [...new Set([...current.hiddenCountryIds, ...draftHiddenCountryIds])],
      }))
      await deleteHiddenLocalCountries(draftHiddenCountryIds)
      reloadAfterLocalSave()
    } catch (error) {
      setEditorNotice(editorErrorNotice(error, 'editor:deleteFailed'))
      setIsSaving(false)
    }
  }

  const addCountry = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!selectedCountryOption) {
      setEditorNotice({ key: 'editor:chooseCountry' })
      return
    }
    setIsSaving(true)
    setEditorNotice({ key: 'editor:creatingCountry' })
    try {
      await addLocalCountry(selectedCountryOption.countryCode, countryVisitedDate)
      reloadAfterLocalSave()
    } catch (error) {
      setEditorNotice(editorErrorNotice(error, 'editor:createFailed'))
      setIsSaving(false)
    }
  }

  const moveCountryAtPointer = useCallback((countryId: CountryId, clientY: number) => {
    const container = countryListRef.current
    if (!container) return
    // Mobile scrolls the whole panel; desktop scrolls the country list itself.
    let scroller: HTMLElement = container
    while (!['auto', 'scroll'].includes(getComputedStyle(scroller).overflowY) && scroller.parentElement) {
      scroller = scroller.parentElement
    }
    const containerRect = scroller.getBoundingClientRect()
    if (clientY < containerRect.top + 42) scroller.scrollBy({ top: -18, behavior: 'instant' })
    if (clientY > containerRect.bottom - 42) scroller.scrollBy({ top: 18, behavior: 'instant' })
    const rows = Array.from(container.querySelectorAll<HTMLElement>('[data-country-sort-id]'))
      .filter((row) => row.dataset.countrySortId !== countryId)
    const beforeRow = rows.find((row) => {
      const rect = row.getBoundingClientRect()
      return clientY < rect.top + rect.height / 2
    })
    const beforeId = beforeRow?.dataset.countrySortId

    setDraftCountryIds((current) => {
      const next = current.filter((id) => id !== countryId)
      const targetIndex = beforeId ? next.indexOf(beforeId) : next.length
      next.splice(targetIndex < 0 ? next.length : targetIndex, 0, countryId)
      return next.every((id, index) => id === current[index]) ? current : next
    })
  }, [countryListRef])

  const moveCountryByStep = (countryId: CountryId, step: -1 | 1) => {
    setDraftCountryIds((current) => {
      const currentIndex = current.indexOf(countryId)
      const nextIndex = Math.max(0, Math.min(current.length - 1, currentIndex + step))
      if (currentIndex < 0 || currentIndex === nextIndex) return current
      const next = [...current]
      next.splice(currentIndex, 1)
      next.splice(nextIndex, 0, countryId)
      return next
    })
  }

  useEffect(() => {
    if (!draggedCountryId) return

    const handlePointerMove = (event: PointerEvent) => {
      if (countryDragPointerRef.current !== event.pointerId) return
      moveCountryAtPointer(draggedCountryId, event.clientY)
    }
    const finishPointerDrag = (event: PointerEvent) => {
      if (countryDragPointerRef.current !== event.pointerId) return
      countryDragPointerRef.current = undefined
      setDraggedCountryId(undefined)
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', finishPointerDrag)
    window.addEventListener('pointercancel', finishPointerDrag)
    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', finishPointerDrag)
      window.removeEventListener('pointercancel', finishPointerDrag)
    }
  }, [draggedCountryId, moveCountryAtPointer])

  useEffect(() => {
    committedDistanceRef.current = globeDistance
    hasDraftDistanceChangeRef.current = false
  }, [globeDistance])

  const commitGlobeDistance = (distance: number) => {
    const hasChanged = Math.abs(distance - committedDistanceRef.current) > 0.001

    if (!hasDraftDistanceChangeRef.current && !hasChanged) return

    hasDraftDistanceChangeRef.current = false
    committedDistanceRef.current = distance
    onDistanceChange(distance)
  }

  return (
    <aside className="atlas-left-panel glass-panel pointer-events-auto z-30 flex w-full max-w-[340px] flex-col p-4 text-left">
      <div className="atlas-country-panel-heading mb-4 flex items-end justify-between gap-3">
        <div className="atlas-panel-body">
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-white">
            {t('details:countryMaps')}</p>
          <h2 className="mt-1 text-xl font-semibold tracking-normal text-slate-950">
            {t('details:visitedCountries')}</h2>
        </div>
        {localEditorAvailable ? (
          <div className="atlas-local-editor-actions">
            {isEditingCountries ? (
              <>
                <button type="button" onClick={resetCountryDraft} aria-label={t('editor:undoCountries')} title={t('editor:undoTitle')}><Undo2 /></button>
                <button type="button" onClick={() => setShowAddCountry((open) => !open)} aria-label={t('editor:addCountry')} title={t('editor:addCountry')}><Plus /></button>
                <button type="button" data-primary="true" onClick={saveCountryDraft} disabled={isSaving} aria-label={t('editor:saveCountries')} title={t('editor:save')}><Check /></button>
              </>
            ) : null}
            <button
              type="button"
              data-active={isEditingCountries}
              onClick={() => {
                if (isEditingCountries) resetCountryDraft()
                setIsEditingCountries((editing) => !editing)
              }}
              aria-label={isEditingCountries ? t('editor:exitCountries') : t('editor:editCountries')}
              title={isEditingCountries ? t('editor:exitEdit') : t('editor:localEdit')}
            >
              {isEditingCountries ? <X /> : <Settings2 />}
            </button>
          </div>
        ) : null}
      </div>

      {isEditingCountries && showAddCountry ? (
        <form className="atlas-local-editor-form" onSubmit={addCountry}>
          <p>{t('editor:countryFirst')}</p>
          <LocationSearchField
            label={t('editor:countryName')}
            placeholder={t('editor:countrySearch')}
            selected={selectedCountryOption}
            search={searchCountryOptions}
            onSelect={setSelectedCountryOption}
            minQueryLength={0}
            getMeta={(option) => `${option.countryCode}${option.region ? ` · ${option.region}` : ''}`}
          />
          <label className="atlas-local-editor-date-field">
            <span>{t('editor:firstVisit')}</span>
            <input required type="date" value={countryVisitedDate} onChange={(event) => setCountryVisitedDate(event.target.value)} />
          </label>
          <button type="submit" disabled={isSaving || !selectedCountryOption}>{t('editor:confirmCountry')}</button>
        </form>
      ) : null}

      {isEditingCountries && draftHiddenCountryIds.length > 0 ? (
        <div className="atlas-local-editor-hidden-actions">
          <button type="button" className="atlas-local-editor-restore" onClick={restoreHiddenCountries} disabled={isSaving}>
            {t('editor:restoreCountries', { count: draftHiddenCountryIds.length })}
          </button>
          <button type="button" className="atlas-local-editor-delete" onClick={deleteHiddenCountries} disabled={isSaving}>
            {t('editor:deleteCountries')}</button>
        </div>
      ) : null}
      {editorNotice ? <p className="atlas-local-editor-notice" role="status">{editorNotice}</p> : null}

      <div ref={countryListRef} className="atlas-country-list atlas-panel-body selector-scrollbar min-h-0 flex-1 space-y-2 overflow-y-auto">
        {displayCountries.map((country) => {
          if (!country) return null
          const isSelected = country.id === selectedCountry?.id
          const countryCities = getCitiesForCountry(country.id).filter((city) => !shouldHideCityFromNavigation(city)
            && (isEditingCountries || browseCityIds === undefined || browseCityIds.has(city.id)))

          return (
            <div
              key={country.id}
              data-flip-id={country.id}
              data-country-sort-id={country.id}
              className="country-disclosure"
              data-editing={isEditingCountries}
              data-dragging={draggedCountryId === country.id}
            >
              {isEditingCountries ? (
                <div className="atlas-local-editor-row-tools">
                  <button
                    type="button"
                    className="atlas-local-editor-drag"
                    aria-label={t('editor:dragFor', { name: name(country) })}
                    title={t('editor:dragHelp')}
                    onPointerDown={(event) => {
                      if (event.button !== 0) return
                      event.preventDefault()
                      countryDragPointerRef.current = event.pointerId
                      event.currentTarget.setPointerCapture(event.pointerId)
                      setDraggedCountryId(country.id)
                    }}
                    onPointerMove={(event) => {
                      if (countryDragPointerRef.current !== event.pointerId) return
                      moveCountryAtPointer(country.id, event.clientY)
                    }}
                    onPointerUp={(event) => {
                      if (countryDragPointerRef.current !== event.pointerId) return
                      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
                      countryDragPointerRef.current = undefined
                      setDraggedCountryId(undefined)
                    }}
                    onPointerCancel={() => {
                      countryDragPointerRef.current = undefined
                      setDraggedCountryId(undefined)
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'ArrowUp') {
                        event.preventDefault()
                        moveCountryByStep(country.id, -1)
                      }
                      if (event.key === 'ArrowDown') {
                        event.preventDefault()
                        moveCountryByStep(country.id, 1)
                      }
                    }}
                  ><GripVertical /></button>
                  <button
                    type="button"
                    className="atlas-local-editor-hide"
                    aria-label={t('editor:hideFor', { name: name(country) })}
                    title={t('editor:hideUndo')}
                    onClick={() => {
                      if (!window.confirm(t('editor:hideConfirm', { name: name(country) }))) return
                      setDraftCountryIds((current) => current.filter((id) => id !== country.id))
                      setDraftHiddenCountryIds((current) => [...new Set([...current, country.id])])
                    }}
                  >
                    <X />
                  </button>
                </div>
              ) : null}
              <button
                type="button"
                aria-expanded={isSelected}
                data-selected={isSelected}
                onClick={() => {
                  if (!isEditingCountries) onSelectCountry(country.id)
                }}
                onPointerEnter={(event) => {
                  if (event.pointerType === 'mouse') onHoverCountry(country.id)
                }}
                onPointerLeave={(event) => {
                  if (event.pointerType === 'mouse') onHoverCountry(undefined)
                }}
                style={{ '--country-color': country.accent } as React.CSSProperties}
                className={`atlas-country-button group flex w-full items-center justify-between gap-3 rounded-full border px-3.5 py-2.5 text-left transition duration-300 ${
                  isSelected
                    ? 'border-slate-950 bg-slate-950 text-white shadow-[0_18px_40px_rgba(15,23,42,0.2)]'
                    : 'border-white/70 bg-white/55 text-slate-700 hover:-translate-y-0.5 hover:bg-white/85'
                }`}
              >
                <span className="flex min-w-0 items-center gap-3">
                  <span
                    className={`grid size-9 shrink-0 place-items-center overflow-hidden rounded-full border shadow-sm ${
                      isSelected ? 'border-white/15 bg-white/12' : 'border-white/80 bg-white/75'
                    }`}
                    aria-hidden="true"
                  >
                    {country.flagCode ? (
                      <img
                        alt=""
                        className="h-full w-full object-cover"
                        src={`https://flagcdn.com/w80/${country.flagCode}.png`}
                      />
                    ) : (
                      <span className="text-base">{country.flag ?? ''}</span>
                    )}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-semibold tracking-normal">{name(country)}</span>
                    <span className={isSelected ? 'block truncate text-xs text-slate-300' : 'block truncate text-xs text-slate-400'}>
                      {subtitle(country)}
                    </span>
                  </span>
                </span>
                <span
                  className="size-2.5 rounded-full shadow-[0_0_18px_var(--country-color)]"
                  style={{ backgroundColor: country.accent }}
                  aria-hidden="true"
                />
              </button>

              <div
                className="country-city-disclosure"
                data-open={isSelected}
                aria-hidden={!isSelected}
              >
                <div className="min-h-0 overflow-hidden">
                  <div className="relative ml-4 mt-2 space-y-1.5 border-l border-dashed border-slate-300/80 pb-1 pl-4 pr-1">
                    <div className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                      <MapPin className="size-3 text-sky-600" />
                      {t('details:visitedCities')}</div>

                    {countryCities.map((city, index) => {
                      const isCitySelected = city.id === selectedCityId
                      const cityHasDroneMedia = hasDroneMedia(city.id)
                      const isDroneMediaActive = city.id === activeDroneMediaCityId

                      return (
                        <div
                          key={city.id}
                          className="country-city-item relative"
                          style={{ '--city-index': index } as React.CSSProperties}
                        >
                          <div className="relative">
                            <span
                              className={`absolute -left-[20px] top-1/2 size-2 -translate-y-1/2 rounded-full border shadow-sm ${
                                isCitySelected
                                  ? 'border-sky-500 bg-sky-500 shadow-[0_0_16px_rgba(14,165,233,0.48)]'
                                  : 'border-white bg-slate-300'
                              }`}
                              aria-hidden="true"
                            />
                            <button
                              type="button"
                              disabled={!isSelected}
                              onClick={() => onSelectCity(city.id)}
                              data-selected={isCitySelected}
                              className={`atlas-city-button flex w-full items-center justify-between gap-2 rounded-full border px-3 py-2 text-left text-xs font-semibold transition duration-200 ${
                                isCitySelected
                                  ? 'border-sky-400 bg-sky-500 text-white shadow-[0_10px_26px_rgba(14,165,233,0.3)]'
                                  : 'border-white/75 bg-white/64 text-slate-600 hover:border-sky-200 hover:bg-white/90 hover:text-slate-950'
                              }`}
                            >
                              <span className="min-w-0 truncate">
                                {name(city)}{' '}
                                <span className={`atlas-city-name-en ${isCitySelected ? 'text-sky-100' : 'font-medium text-slate-400'}`}>
                                  {subtitle(city)}
                                </span>
                              </span>
                              {cityHasDroneMedia ? (
                                <span
                                  className="drone-city-indicator grid size-6 shrink-0 place-items-center rounded-full"
                                  title={t('details:droneAvailable')}
                                  aria-label={t('details:droneAvailable')}
                                >
                                  <Drone className="size-3.5" />
                                </span>
                              ) : null}
                            </button>
                          </div>

                          {isCitySelected && cityHasDroneMedia ? (
                            <button
                              type="button"
                              onClick={() => onSelectDroneMedia(city.id)}
                              data-active={isDroneMediaActive}
                              className="drone-media-entry ml-3 mt-1.5 flex w-[calc(100%-12px)] items-center gap-2 rounded-full border px-3 py-2 text-left text-[11px] font-semibold transition duration-200"
                            >
                              <Drone className="size-3.5 shrink-0" />
                              <span className="truncate">{t('details:droneMedia')}</span>
                            </button>
                          ) : null}
                        </div>
                      )
                    })}
                  </div>
                </div>
              </div>
            </div>
          )
        })}
      </div>

      <div className="atlas-image-tuning atlas-panel-body mt-3 shrink-0 border-t">
        <div className={`atlas-scale-heading flex items-center justify-between gap-3 ${isImageTuningOpen ? 'mb-3' : ''}`}>
          <button
            aria-controls="atlas-image-tuning-controls"
            aria-expanded={isImageTuningOpen}
            className="atlas-accordion-trigger flex min-w-0 flex-1 items-center justify-between gap-3 text-left"
            onClick={() => setIsImageTuningOpen((isOpen) => !isOpen)}
            type="button"
          >
            <span className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">
              <SlidersHorizontal className="size-4 text-slate-500" />
              {t('details:mapTuning')}</span>
            <ChevronDown className={`atlas-accordion-chevron size-4 shrink-0 ${isImageTuningOpen ? '' : 'rotate-180'}`} />
          </button>
          {isImageTuningOpen ? (
            <button
              aria-label={t('details:resetTuning')}
              className="atlas-scale-reset grid size-9 shrink-0 place-items-center rounded-lg border"
              onClick={onResetImageryTuning}
              title={t('details:resetTuning')}
              type="button"
            >
              <RotateCcw className="size-4" />
            </button>
          ) : (
            <span aria-hidden="true" className="size-9 shrink-0" />
          )}
        </div>

        {isImageTuningOpen ? (
          <div className="atlas-accordion-content" id="atlas-image-tuning-controls">
            <label className="atlas-image-control grid grid-cols-[68px_1fr_34px] items-center gap-2">
              <span>{t('details:saturation')}</span>
              <input
                aria-label={t('details:saturationAria')}
                className="atlas-image-slider atlas-slider w-full"
                max="1.5"
                min="0.5"
                step="0.01"
                type="range"
                value={imagerySaturation}
                onChange={(event) => onSaturationChange(Number(event.currentTarget.value))}
              />
              <output>{imagerySaturation.toFixed(2)}</output>
            </label>

            <label className="atlas-image-control grid grid-cols-[68px_1fr_34px] items-center gap-2">
              <span>{t('details:contrast')}</span>
              <input
                aria-label={t('details:contrastAria')}
                className="atlas-image-slider atlas-slider w-full"
                max="1.4"
                min="0.7"
                step="0.01"
                type="range"
                value={imageryContrast}
                onChange={(event) => onContrastChange(Number(event.currentTarget.value))}
              />
              <output>{imageryContrast.toFixed(2)}</output>
            </label>

            <label className="atlas-image-control grid grid-cols-[68px_1fr_34px] items-center gap-2">
              <span>{t('details:brightness')}</span>
              <input
                aria-label={t('details:brightnessAria')}
                className="atlas-image-slider atlas-slider w-full"
                max="1.4"
                min="0.4"
                step="0.01"
                type="range"
                value={imageryBrightness}
                onChange={(event) => onBrightnessChange(Number(event.currentTarget.value))}
              />
              <output>{imageryBrightness.toFixed(2)}</output>
            </label>
          </div>
        ) : null}
      </div>

      <div className="atlas-scale-panel atlas-panel-body mt-3 shrink-0 rounded-[22px] border border-white/70 bg-white/54 p-3.5">
        <div className={`atlas-scale-heading flex items-center justify-between gap-3 ${isGlobeScaleOpen ? 'mb-3' : ''}`}>
          <button
            aria-controls="atlas-globe-scale-controls"
            aria-expanded={isGlobeScaleOpen}
            className="atlas-accordion-trigger flex min-w-0 flex-1 items-center justify-between gap-3 text-left"
            onClick={() => setIsGlobeScaleOpen((isOpen) => !isOpen)}
            type="button"
          >
            <span className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">
              <SlidersHorizontal className="size-4 text-slate-500" />
              {t('details:globeScale')}</span>
            <ChevronDown className={`atlas-accordion-chevron size-4 shrink-0 ${isGlobeScaleOpen ? '' : 'rotate-180'}`} />
          </button>
          {isGlobeScaleOpen ? (
            <button
              type="button"
              aria-label={t('details:resetGlobe')}
              title={t('details:resetGlobe')}
              onClick={onResetView}
              className="atlas-scale-reset grid size-9 shrink-0 place-items-center rounded-lg border"
            >
              <RotateCcw className="size-4" />
            </button>
          ) : (
            <span aria-hidden="true" className="size-9 shrink-0" />
          )}
        </div>
        {isGlobeScaleOpen ? (
          <div className="atlas-accordion-content" id="atlas-globe-scale-controls">
            <input
              aria-label={t('details:globeScaleAria')}
              className="atlas-slider w-full"
              defaultValue={globeDistance}
              key={globeDistance}
              max="3.25"
              min="1"
              step="0.05"
              type="range"
              onInput={(event) => {
                const nextDistance = Number(event.currentTarget.value)
                hasDraftDistanceChangeRef.current =
                  Math.abs(nextDistance - committedDistanceRef.current) > 0.001
                debugGlobeScaleChange(nextDistance)
              }}
              onKeyUp={(event) => commitGlobeDistance(Number(event.currentTarget.value))}
              onBlur={(event) => commitGlobeDistance(Number(event.currentTarget.value))}
              onPointerCancel={(event) => commitGlobeDistance(Number(event.currentTarget.value))}
              onPointerUp={(event) => commitGlobeDistance(Number(event.currentTarget.value))}
            />
            <div className="mt-1 flex justify-between text-[11px] font-medium text-slate-400">
              <span>{t('details:city')}</span>
              <span>{t('details:country')}</span>
              <span>{t('details:world')}</span>
            </div>
          </div>
        ) : null}
      </div>
    </aside>
  )
}
