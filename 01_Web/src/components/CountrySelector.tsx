import { editorErrorNotice } from '../i18n/editorErrors.ts'
import { usePlaceNames } from '../i18n/usePlaceNames'
import { useLocalizedNotice } from '../i18n/useLocalizedNotice'
import { useTranslation } from 'react-i18next'
import { memo, useCallback, useEffect, useId, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { Check, ChevronDown, Drone, GripVertical, MapPin, Plus, RotateCcw, Settings2, SlidersHorizontal, Undo2, X } from 'lucide-react'
import { withoutListedCountries } from '../data/countrySearchFilter'
import { useDroneMedia } from '../data/droneMedia'
import { localEditorAvailable, useTravelAtlasEditorState } from '../data/editorState'
import { addLocalCountry, applyLocalViewOperations, deleteHiddenLocalCountries, searchLocalCountries } from '../data/localEditorClient'
import { once, useDraft } from '../data/drafts'
import { countryListProbe } from '../data/draftProbes'
import { countryDraftOperations, hideIdsOperation, restoreHiddenOperation } from '../data/editorStateDelta'
import type { CountrySearchOption } from '../data/localEditorApi'
import { useTravelAtlas } from '../data/travelAtlas'
import type { City, CityId, Country, CountryId } from '../types/travel'
import { countryFlagUrl } from './countryFlagUrl'
import { LocationSearchField } from './LocationSearchField'
import { DraftConflictNotice } from './DraftConflictNotice'
import { useFlipLayout } from './useFlipLayout'
import { useStableCallback } from './useStableCallback'

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
  const { countries, getCitiesForCountry, shouldHideCityFromNavigation } = useTravelAtlas()
  const travelAtlasEditorState = useTravelAtlasEditorState()
  const { hasDroneMedia } = useDroneMedia()
  const selectedCountry = selectedCountryId ? countries.find((country) => country.id === selectedCountryId) : undefined
  const committedDistanceRef = useRef(globeDistance)
  const hasDraftDistanceChangeRef = useRef(false)
  const globeScaleInputRef = useRef<HTMLInputElement>(null)
  const [isImageTuningOpen, setIsImageTuningOpen] = useState(false)
  const [isGlobeScaleOpen, setIsGlobeScaleOpen] = useState(true)
  const defaultCountryIds = (travelAtlasEditorState.countryOrder.length > 0
    ? countries
    : [...countries].reverse()).map((country) => country.id)
  // 3C-5 D: the draft starts when editing starts, from the data on the page then (its baseline and revision), and ends
  // with the save or the exit; without a draft the list shows the data. Saves apply only the difference from the baseline (D1).
  const countryDraft = useDraft(countryListProbe)
  const isEditingCountries = countryDraft.active
  const [draftCountryIds, setDraftCountryIds] = useState<CountryId[]>([])
  const [draftHiddenCountryIds, setDraftHiddenCountryIds] = useState<CountryId[]>([])
  const [baselineCountryOrder, setBaselineCountryOrder] = useState<readonly CountryId[]>([])
  const [baselineHiddenCountryIds, setBaselineHiddenCountryIds] = useState<readonly CountryId[]>([])
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
  const shownCountryIds = isEditingCountries ? draftCountryIds : defaultCountryIds
  const displayCountries = shownCountryIds.map((id) => countriesById.get(id))
    .filter((country) => country !== undefined && (isEditingCountries || browseCountryIds === undefined || browseCountryIds.has(country.id)))
  const countryListRef = useFlipLayout<HTMLDivElement>(shownCountryIds.join('|'))
  const searchCountryOptions = useCallback(async (query: string, signal: AbortSignal) => {
    const results = await searchLocalCountries(query, signal)
    // 目录候选的 id 是名字 slug，V2 下国家的 id 是地点 UUID：按 id 或国家代码判断「已在列表里」（RFC-LOC-1 PR3b-2）。
    return withoutListedCountries(results, countries)
  }, [countries])

  const startCountryDraft = () => {
    countryDraft.begin()
    setDraftCountryIds(defaultCountryIds)
    setDraftHiddenCountryIds(travelAtlasEditorState.hiddenCountryIds)
    setBaselineCountryOrder(travelAtlasEditorState.countryOrder)
    setBaselineHiddenCountryIds(travelAtlasEditorState.hiddenCountryIds)
  }
  const closeAddCountry = () => {
    setShowAddCountry(false)
    setSelectedCountryOption(undefined)
    setCountryVisitedDate('')
  }
  const closeCountryDraft = () => {
    countryDraft.end()
    closeAddCountry()
  }
  // 3C-5 D: the list changed elsewhere while the draft is open: the save waits for the user's choice. Keeping the draft
  // takes the list as it is now as the baseline, so the save writes the draft's order and hidden countries over it.
  const countryConflictId = useId()
  const countryConflict = countryDraft.status === 'changed' || countryDraft.status === 'deleted'
  const keepCountryDraft = () => {
    countryDraft.keepMine()
    setBaselineCountryOrder(travelAtlasEditorState.countryOrder)
    setBaselineHiddenCountryIds(travelAtlasEditorState.hiddenCountryIds)
    setEditorNotice('')
  }
  /** A write of the draft is saved: the page shows the data (3C-5 D: no reload), the editor closes. */
  const countryDraftSaved = () => {
    closeCountryDraft()
    setIsSaving(false)
    setEditorNotice('')
  }
  // Undo: the draft starts again from the data on the page now.
  const resetCountryDraft = () => {
    startCountryDraft()
    closeAddCountry()
    setEditorNotice({ key: 'editor:undoNotice' })
  }

  const saveCountryDraft = async () => {
    setIsSaving(true)
    setEditorNotice({ key: 'editor:saving' })
    // 3C-5 D: the editor closes in the same render as the saved data (onApplied), once.
    const saved = once(countryDraftSaved)
    try {
      await applyLocalViewOperations(countryDraftOperations({
        draftCountryIds, baselineCountryOrder, baselineHiddenCountryIds, draftHiddenCountryIds,
      }), { ...countryDraft.writeOptions(), onApplied: saved })
      saved()
    } catch (error) {
      setEditorNotice(editorErrorNotice(error, 'editor:saveFailed'))
      setIsSaving(false)
    }
  }

  const restoreHiddenCountries = async () => {
    if (draftHiddenCountryIds.length === 0) return
    setIsSaving(true)
    const saved = once(countryDraftSaved)
    try {
      // Only the countries listed here; a country hidden elsewhere after this page loaded stays hidden (D1).
      await applyLocalViewOperations([restoreHiddenOperation('countries', draftHiddenCountryIds)], { ...countryDraft.writeOptions(), onApplied: saved })
      saved()
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
      await applyLocalViewOperations([hideIdsOperation('countries', draftHiddenCountryIds)], countryDraft.writeOptions())
      // The second write follows the first one: on the revision of the data on the page now.
      await deleteHiddenLocalCountries(draftHiddenCountryIds)
      countryDraftSaved()
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
    const saved = once(countryDraftSaved)
    try {
      await addLocalCountry(selectedCountryOption.countryCode, countryVisitedDate, { ...countryDraft.writeOptions(), onApplied: saved })
      saved()
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
    // The slider stays uncontrolled and mounted: an outside change (reset view, choosing a place) moves its thumb here.
    // Rebuilding it for every new value (key={globeDistance}) dropped keyboard focus after each committed arrow key.
    if (globeScaleInputRef.current) globeScaleInputRef.current.value = String(globeDistance)
  }, [globeDistance])

  // 3C-5 D: what the rows do, stable (the rows are memoized: after a save only the rows whose values changed render).
  const moveCountryAtPointerStable = useStableCallback(moveCountryAtPointer)
  const moveCountryByStepStable = useStableCallback(moveCountryByStep)
  const onSelectCountryStable = useStableCallback(onSelectCountry)
  const onHoverCountryStable = useStableCallback(onHoverCountry)
  const onSelectCityStable = useStableCallback(onSelectCity)
  const onSelectDroneMediaStable = useStableCallback(onSelectDroneMedia)
  const setDragPointer = useCallback((pointerId: number | undefined) => { countryDragPointerRef.current = pointerId }, [])
  const isDragPointer = useCallback((pointerId: number) => countryDragPointerRef.current === pointerId, [])
  const rowActions = useMemo<CountryRowActions>(() => ({
    setDragPointer,
    isDragPointer,
    setDraggedCountryId,
    setDraftCountryIds,
    setDraftHiddenCountryIds,
    moveCountryAtPointer: moveCountryAtPointerStable,
    moveCountryByStep: moveCountryByStepStable,
    onSelectCountry: onSelectCountryStable,
    onHoverCountry: onHoverCountryStable,
    onSelectCity: onSelectCityStable,
    onSelectDroneMedia: onSelectDroneMediaStable,
  }), [setDragPointer, isDragPointer, moveCountryAtPointerStable, moveCountryByStepStable, onSelectCountryStable, onHoverCountryStable, onSelectCityStable, onSelectDroneMediaStable])

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
                <button type="button" data-primary="true" onClick={saveCountryDraft} disabled={isSaving || countryConflict} aria-describedby={countryConflict ? countryConflictId : undefined} aria-label={t('editor:saveCountries')} title={t('editor:save')}><Check /></button>
              </>
            ) : null}
            <button
              type="button"
              data-active={isEditingCountries}
              onClick={() => {
                if (isEditingCountries) closeCountryDraft()
                else startCountryDraft()
              }}
              aria-label={isEditingCountries ? t('editor:exitCountries') : t('editor:editCountries')}
              title={isEditingCountries ? t('editor:exitEdit') : t('editor:localEdit')}
            >
              {isEditingCountries ? <X /> : <Settings2 />}
            </button>
          </div>
        ) : null}
      </div>

      {isEditingCountries ? (
        <DraftConflictNotice
          id={countryConflictId}
          status={countryDraft.status}
          before={countryDraft.baseValue}
          after={countryDraft.current}
          busy={isSaving}
          onKeepMine={keepCountryDraft}
          onTakeTheirs={() => { startCountryDraft(); setEditorNotice('') }}
          onDiscard={closeCountryDraft}
        />
      ) : null}

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
          const countryCities = getCitiesForCountry(country.id).filter((city) => !shouldHideCityFromNavigation(city)
            && (isEditingCountries || browseCityIds === undefined || browseCityIds.has(city.id)))

          return (
            <CountryRow
              key={country.id}
              country={country}
              isSelected={country.id === selectedCountry?.id}
              isEditing={isEditingCountries}
              isDragging={draggedCountryId === country.id}
              cities={countryCities}
              selectedCityId={countryCities.some((city) => city.id === selectedCityId) ? selectedCityId : undefined}
              activeDroneMediaCityId={countryCities.some((city) => city.id === activeDroneMediaCityId) ? activeDroneMediaCityId : undefined}
              droneCityIds={JSON.stringify(countryCities.filter((city) => hasDroneMedia(city.id)).map((city) => city.id))}
              actions={rowActions}
            />
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
              ref={globeScaleInputRef}
              defaultValue={globeDistance}
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

type CountryCityListProps = {
  /** The cities of the country that the list shows. */
  cities: readonly City[]
  /** The country is selected: its list is open. */
  isSelected: boolean
  /** The selected city and the city whose drone media are shown, when they are among these cities. */
  selectedCityId?: CityId
  activeDroneMediaCityId?: CityId
  /** The ids of these cities that have drone media, as JSON (a value, compared as such). */
  droneCityIds: string
  onSelectCity: (cityId: CityId) => void
  onSelectDroneMedia: (cityId: CityId) => void
}

/** The same cities: the same ids and names (the data store makes new objects after a save). */
const sameCities = (a: readonly City[], b: readonly City[]) => a === b
  || JSON.stringify(a.map((city) => [city.id, city.nameZh, city.nameEn])) === JSON.stringify(b.map((city) => [city.id, city.nameZh, city.nameEn]))

/**
 * 3C-5 D: a country's cities, memoized on their values: after a save (the list of countries renders again, e.g. when the
 * order was saved), only the lists whose cities or selection changed render again.
 */
const CountryCityList = memo(function CountryCityList({
  cities, isSelected, selectedCityId, activeDroneMediaCityId, droneCityIds, onSelectCity, onSelectDroneMedia,
}: CountryCityListProps) {
  const { t } = useTranslation(['details'])
  const { name, subtitle } = usePlaceNames()
  const droneCities = new Set(JSON.parse(droneCityIds) as string[])
  return (
    <>
      {cities.map((city, index) => {
        const isCitySelected = city.id === selectedCityId
        const cityHasDroneMedia = droneCities.has(city.id)
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
    </>
  )
}, (a, b) => a.isSelected === b.isSelected && a.selectedCityId === b.selectedCityId && a.activeDroneMediaCityId === b.activeDroneMediaCityId
  && a.droneCityIds === b.droneCityIds && a.onSelectCity === b.onSelectCity && a.onSelectDroneMedia === b.onSelectDroneMedia && sameCities(a.cities, b.cities))

/** What a country row does (stable: see `rowActions`). */
type CountryRowActions = {
  /** The pointer that drags a row (kept by the list: its window listeners follow it too). */
  setDragPointer: (pointerId: number | undefined) => void
  isDragPointer: (pointerId: number) => boolean
  setDraggedCountryId: Dispatch<SetStateAction<CountryId | undefined>>
  setDraftCountryIds: Dispatch<SetStateAction<CountryId[]>>
  setDraftHiddenCountryIds: Dispatch<SetStateAction<CountryId[]>>
  moveCountryAtPointer: (countryId: CountryId, clientY: number) => void
  moveCountryByStep: (countryId: CountryId, step: -1 | 1) => void
  onSelectCountry: (countryId: CountryId) => void
  onHoverCountry: (countryId?: CountryId) => void
  onSelectCity: (cityId: CityId) => void
  onSelectDroneMedia: (cityId: CityId) => void
}

type CountryRowProps = {
  country: Country
  isSelected: boolean
  isEditing: boolean
  isDragging: boolean
} & Omit<CountryCityListProps, 'isSelected' | 'onSelectCity' | 'onSelectDroneMedia'> & { actions: CountryRowActions }

/** The same country for its row: the values the row shows (the data store makes new objects after a save). */
const countryValues = (country: Country) => [country.id, country.accent, country.flagCode, country.flag, country.nameZh, country.nameEn]

/**
 * 3C-5 D: one country of the list, memoized on its values: a save, or the saving state, renders only the rows whose
 * values changed (leaving the editing mode still renders them all).
 */
const CountryRow = memo(function CountryRow({
  country, isSelected, isEditing, isDragging, cities, selectedCityId, activeDroneMediaCityId, droneCityIds, actions,
}: CountryRowProps) {
  const { t } = useTranslation(['details', 'editor', 'journey'])
  const { name, subtitle } = usePlaceNames()
  const flagUrl = countryFlagUrl(country.flagCode)
  return (
    <div
      data-flip-id={country.id}
      data-country-sort-id={country.id}
      className="country-disclosure"
      data-editing={isEditing}
      data-dragging={isDragging}
    >
      {isEditing ? (
        <div className="atlas-local-editor-row-tools">
          <button
            type="button"
            className="atlas-local-editor-drag"
            aria-label={t('editor:dragFor', { name: name(country) })}
            title={t('editor:dragHelp')}
            onPointerDown={(event) => {
              if (event.button !== 0) return
              event.preventDefault()
              actions.setDragPointer(event.pointerId)
              event.currentTarget.setPointerCapture(event.pointerId)
              actions.setDraggedCountryId(country.id)
            }}
            onPointerMove={(event) => {
              if (!actions.isDragPointer(event.pointerId)) return
              actions.moveCountryAtPointer(country.id, event.clientY)
            }}
            onPointerUp={(event) => {
              if (!actions.isDragPointer(event.pointerId)) return
              if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
              actions.setDragPointer(undefined)
              actions.setDraggedCountryId(undefined)
            }}
            onPointerCancel={() => {
              actions.setDragPointer(undefined)
              actions.setDraggedCountryId(undefined)
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowUp') {
                event.preventDefault()
                actions.moveCountryByStep(country.id, -1)
              }
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                actions.moveCountryByStep(country.id, 1)
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
              actions.setDraftCountryIds((current) => current.filter((id) => id !== country.id))
              actions.setDraftHiddenCountryIds((current) => [...new Set([...current, country.id])])
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
          if (!isEditing) actions.onSelectCountry(country.id)
        }}
        onPointerEnter={(event) => {
          if (event.pointerType === 'mouse') actions.onHoverCountry(country.id)
        }}
        onPointerLeave={(event) => {
          if (event.pointerType === 'mouse') actions.onHoverCountry(undefined)
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
            {flagUrl ? (
              <img
                alt=""
                className="h-full w-full object-cover"
                src={flagUrl}
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

            <CountryCityList
              cities={cities}
              isSelected={isSelected}
              selectedCityId={selectedCityId}
              activeDroneMediaCityId={activeDroneMediaCityId}
              droneCityIds={droneCityIds}
              onSelectCity={actions.onSelectCity}
              onSelectDroneMedia={actions.onSelectDroneMedia}
            />
          </div>
        </div>
      </div>
    </div>
  )
}, (a, b) => a.isSelected === b.isSelected && a.isEditing === b.isEditing && a.isDragging === b.isDragging
  && a.selectedCityId === b.selectedCityId && a.activeDroneMediaCityId === b.activeDroneMediaCityId && a.droneCityIds === b.droneCityIds
  && a.actions === b.actions && sameCities(a.cities, b.cities)
  && (a.country === b.country || JSON.stringify(countryValues(a.country)) === JSON.stringify(countryValues(b.country))))
