import { usePlaceNames } from '../i18n/usePlaceNames'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowUpRight, Clock3, MapPin, Sparkles } from 'lucide-react'
import { cityById, countryById, journeyDays } from '../data/travelAtlas'
import type { CityId, JourneyDay } from '../types/travel'
import { buildBrowseTimeProjection, journeyTimeContext, type BrowseTimeProjection } from '../data/derive/browseTimeProjection'

type TimelineProps = {
  selectedDayId: string
  onSelectDay: (day: JourneyDay) => void
  onHoverCity: (cityId?: CityId) => void
  projection?: BrowseTimeProjection
}

export function Timeline({ selectedDayId, onSelectDay, onHoverCity, projection }: TimelineProps) {
  const { t } = useTranslation(['details', 'editor', 'journey'])
  const { name, subtitle } = usePlaceNames()
  const browse = useMemo(() => projection ?? buildBrowseTimeProjection(journeyTimeContext(journeyDays, cityById), {}), [projection])
  const unknownDate = t('journey:unknownDate')
  const uncertainDate = t('journey:uncertainDate')
  const yearOnly = t('journey:yearOnly')
  const emptyLabel = t('journey:noMatchingVisits')
  const unknownRecordIds = useMemo(() => new Set(browse.uncertainJourneyRecords.map(match => match.record.recordId)), [browse])
  const orderedDays = useMemo(() => {
    const daysById = new Map(journeyDays.map(day => [day.id, day]))
    return browse.orderedJourneyRecords.map(match => daysById.get(match.record.recordId)).filter((day): day is JourneyDay => day !== undefined)
  }, [browse])
  const knownYear = (day: JourneyDay) => {
    const evidence = browse.travelMatchesById.get(day.id)?.record.date
    return !unknownRecordIds.has(day.id) && evidence?.range.from
      ? evidence.range.from.slice(0, 4) : unknownDate
  }
  return (
    <section id="stories" className="journey-view-section journey-timeline-section">
      <div className="journey-section-heading">
        <div>
          <p className="journey-kicker">{t('journey:latestFirst')}</p>
          <h2>{t('journey:timelineHeading')}</h2>
        </div>
        <div className="journey-order-note">
          <Clock3 aria-hidden="true" />
          <span>{t('journey:orderNote')}</span>
        </div>
      </div>

      <div className="journey-timeline-rail">
        {orderedDays.length === 0 ? <p className="journey-order-note">{emptyLabel}</p> : null}
        {orderedDays.map((day, index) => {
          const city = cityById[day.cityId]
          const country = day.countryId ? countryById[day.countryId] : undefined
          if (!city || !country) return null

          const isSelected = day.id === selectedDayId
          const match = browse.travelMatchesById.get(day.id)
          const year = knownYear(day)
          const showYear = index === 0 || knownYear(orderedDays[index - 1]) !== year
          const range = match?.record.date.range
          const dateLabel = match?.record.date.precision === 'day' && range?.from && range.to
            ? range.from === range.to ? range.from : `${range.from} – ${range.to}`
            : year

          return (
            <article key={day.id} className="journey-timeline-entry">
              {showYear ? <div className="journey-year-marker">{year}</div> : null}
              <span
                aria-hidden="true"
                className="journey-timeline-node"
                style={{ '--journey-accent': country.accent } as React.CSSProperties}
              />
              <button
                type="button"
                className="journey-timeline-card journey-timeline-card-compact"
                data-selected={isSelected}
                style={{ '--journey-accent': country.accent } as React.CSSProperties}
                onClick={() => onSelectDay(day)}
                onMouseEnter={() => onHoverCity(day.cityId)}
                onMouseLeave={() => onHoverCity(undefined)}
              >
                <span className="journey-timeline-date">
                  <span>{dateLabel}{match?.record.date.precision === 'year' ? ` · ${yearOnly}` : ''}{match?.result.match === 'uncertain' ? ` · ${uncertainDate}` : ''}</span>
                  {country.flagCode ? (
                    <span className="journey-timeline-flag" aria-hidden="true">
                      <img
                        alt=""
                        src={`https://flagcdn.com/w80/${country.flagCode}.png`}
                      />
                    </span>
                  ) : (
                    <span>{country.flag ?? '•'}</span>
                  )}
                </span>

                <span className="journey-timeline-copy">
                  <span className="journey-timeline-place">
                    <MapPin aria-hidden="true" />
                    <strong>{name(city)}</strong>
                    <span>{subtitle(city)}</span>
                  </span>
                  <span className="journey-timeline-country-line">
                    <strong>{name(country)}</strong>
                    <span>{subtitle(country)}</span>
                  </span>
                </span>

                <span className="journey-timeline-open" aria-hidden="true">
                  <ArrowUpRight />
                </span>
              </button>
            </article>
          )
        })}
      </div>

      <div className="journey-public-note">
        <Sparkles aria-hidden="true" />
        <span>{t('journey:publicNote')}</span>
      </div>
    </section>
  )
}
