import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { TRAVEL_LAYER_ID, WANT_TO_GO_LAYER_ID } from '../worldgraph/layers'
import { isTimeFilterActive, normalizeTimeFilter, timeFilterForYear } from '../worldgraph/timeFilter'
import type { TimeFilter, TimeFilterError } from '../worldgraph/timeFilter'
import type { LayerTimeFilters as FilterState } from '../worldgraph/timeQuery'
import type { LayerId } from '../worldgraph/types'
import './LayerTimeFilters.css'

type Words = { errors: Record<TimeFilterError, string>;
  title: string; travel: string; want: string; all: string; active: string; clearAll: string; clear: string;
  from: string; to: string; apply: string; year: string; applyYear: string; yearHint: string; include: string;
  hint: string; meanings: string; storage: string; uncertainHint: string; datePlaceholder: string
}

export interface LayerTimeFiltersProps {
  filters: FilterState
  onChange: (filters: FilterState) => void
  storageWarning?: boolean
  locale?: string
  activeLayer?: LayerId
}

function FilterEditor({ layerId, filters, onChange, words, resetSequence, activeLayer }: {
  layerId: LayerId; filters: FilterState; onChange: LayerTimeFiltersProps['onChange']; words: Words; resetSequence: number; activeLayer?: LayerId
}) {
  const id = useId()
  const filter = filters[layerId] ?? { includeUncertain: false }
  const signature = `${resetSequence}|${filter.from ?? ''}|${filter.to ?? ''}|${filter.includeUncertain}`
  const [lastSignature, setLastSignature] = useState(signature)
  const [from, setFrom] = useState(filter.from ?? '')
  const [to, setTo] = useState(filter.to ?? '')
  const [includeUncertain, setIncludeUncertain] = useState(filter.includeUncertain)
  const [year, setYear] = useState('')
  const [errors, setErrors] = useState<readonly TimeFilterError[]>([])
  // Only a changed effective condition (or explicit clear) resets this layer.
  // Locale changes and changes to the other layer keep its unsaved date draft.
  if (lastSignature !== signature) {
    setLastSignature(signature)
    setFrom(filter.from ?? '')
    setTo(filter.to ?? '')
    setIncludeUncertain(filter.includeUncertain)
    setYear('')
    setErrors([])
  }
  const apply = (next: TimeFilter) => {
    setErrors([])
    setFrom(next.from ?? '')
    setTo(next.to ?? '')
    setIncludeUncertain(next.includeUncertain)
    onChange({ ...filters, [layerId]: next })
  }
  const applyDates = () => {
    const normalized = normalizeTimeFilter({ from, to, includeUncertain })
    if (normalized.ok) apply(normalized.filter)
    else setErrors(normalized.errors)
  }
  const applyYear = () => {
    const normalized = timeFilterForYear(/^\d{1,4}$/.test(year) ? Number(year) : undefined, includeUncertain)
    if (normalized.ok) apply(normalized.filter)
    else setErrors(normalized.errors)
  }
  const active = isTimeFilterActive(filter)
  const title = layerId === TRAVEL_LAYER_ID ? words.travel : words.want
  return <details className="layer-time-filter" data-layer={layerId} open={activeLayer === layerId || undefined}>
    <summary>
      <strong>{title}</strong>
      <span className="layer-time-status" data-active={active}>{active ? words.active : words.all}</span>
      {active ? <small>{filter.from ?? '…'} → {filter.to ?? '…'}</small> : null}
    </summary>
    <div className="layer-time-fields">
      {layerId === WANT_TO_GO_LAYER_ID ? <p className="layer-time-hint">{words.meanings}</p> : null}
      <div className="layer-time-year">
        <label htmlFor={`${id}-year`}>{words.year}
          <input id={`${id}-year`} type="text" inputMode="numeric" autoComplete="off" maxLength={4}
            value={year} onChange={(event) => setYear(event.target.value)} placeholder={words.yearHint}
            aria-invalid={errors.includes('invalid-year')}
            aria-describedby={errors.includes('invalid-year') ? `${id}-errors` : undefined} />
        </label>
        <button type="button" onClick={applyYear}>{words.applyYear}</button>
      </div>
      <div className="layer-time-dates">
        <label htmlFor={`${id}-from`}>{words.from}
          <input id={`${id}-from`} type="text" autoComplete="off" placeholder={words.datePlaceholder}
            value={from} onChange={(event) => setFrom(event.target.value)}
            aria-invalid={errors.includes('invalid-from') || errors.includes('reversed-range')}
            aria-describedby={errors.length ? `${id}-errors` : `${id}-hint`} />
        </label>
        <label htmlFor={`${id}-to`}>{words.to}
          <input id={`${id}-to`} type="text" autoComplete="off" placeholder={words.datePlaceholder}
            value={to} onChange={(event) => setTo(event.target.value)}
            aria-invalid={errors.includes('invalid-to') || errors.includes('reversed-range')}
            aria-describedby={errors.length ? `${id}-errors` : `${id}-hint`} />
        </label>
      </div>
      <p className="layer-time-hint" id={`${id}-hint`}>{words.hint}</p>
      <label className="layer-time-check">
        <input type="checkbox" checked={includeUncertain} onChange={(event) => {
          setIncludeUncertain(event.target.checked)
          setLastSignature(`${resetSequence}|${filter.from ?? ''}|${filter.to ?? ''}|${event.target.checked}`)
          // Apply to the last valid dates; an unfinished date draft never leaks.
          onChange({ ...filters, [layerId]: { ...filter, includeUncertain: event.target.checked } })
        }} />
        <span>{words.include}</span>
      </label>
      {includeUncertain ? <p className="layer-time-hint">{words.uncertainHint}</p> : null}
      {errors.length ? <p className="layer-time-error" id={`${id}-errors`} role="alert">
        {errors.map((error) => words.errors[error]).join(' ')}
      </p> : null}
      <div className="layer-time-actions">
        <button type="button" className="layer-time-apply" onClick={applyDates}>{words.apply}</button>
        <button type="button" onClick={() => { setYear(''); apply({ includeUncertain: false }) }}>{words.clear}</button>
      </div>
    </div>
  </details>
}

export function LayerTimeFilters({ filters, onChange, storageWarning = false, locale, activeLayer }: LayerTimeFiltersProps) {
  const { t } = useTranslation('timeFilter', { lng: locale })
  const words: Words = {
    title: t('title'), travel: t('travel'), want: t('want'), all: t('all'), active: t('active'),
    clearAll: t('clearAll'), clear: t('clear'), from: t('from'), to: t('to'), apply: t('apply'),
    year: t('year'), applyYear: t('applyYear'), yearHint: t('yearHint'), include: t('include'),
    hint: t('hint'), meanings: t('meanings'), storage: t('storage'), uncertainHint: t('uncertainHint'),
    datePlaceholder: t('datePlaceholder'), errors: {
      'invalid-filter': t('errors.invalid-filter'), 'invalid-from': t('errors.invalid-from'),
      'invalid-to': t('errors.invalid-to'), 'reversed-range': t('errors.reversed-range'),
      'invalid-include-uncertain': t('errors.invalid-include-uncertain'), 'invalid-year': t('errors.invalid-year'),
    },
  }
  const [resetSequence, setResetSequence] = useState(0)
  return <section className="layer-time-filters" aria-label={words.title}>
    <div className="layer-time-heading">
      <strong>{words.title}</strong>
      <button type="button" onClick={() => { setResetSequence((value) => value + 1); onChange({}) }}>{words.clearAll}</button>
    </div>
    {storageWarning ? <p className="layer-time-warning" role="status">{words.storage}</p> : null}
    {[TRAVEL_LAYER_ID, WANT_TO_GO_LAYER_ID].map((layerId) => <FilterEditor key={layerId}
      layerId={layerId} filters={filters} onChange={onChange} words={words} resetSequence={resetSequence} activeLayer={activeLayer} />)}
  </section>
}
