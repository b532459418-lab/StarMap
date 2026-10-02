import { usePlaceNames } from '../i18n/usePlaceNames'
import { useTranslation } from 'react-i18next'
import { ArrowUpRight, Clock3, MapPin, Sparkles } from 'lucide-react'
import { cityById, countryById, journeyDays } from '../data/travelAtlas'
import type { CityId, JourneyDay } from '../types/travel'

type TimelineProps = {
  selectedDayId: string
  onSelectDay: (day: JourneyDay) => void
  onHoverCity: (cityId?: CityId) => void
}

const orderedDays = [...journeyDays].sort((left, right) =>
  `${right.date}-${right.id}`.localeCompare(`${left.date}-${left.id}`),
)

export function Timeline({ selectedDayId, onSelectDay, onHoverCity }: TimelineProps) {
  const { t } = useTranslation(['details', 'editor', 'journey'])
  const { name, subtitle } = usePlaceNames()
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
        {orderedDays.map((day, index) => {
          const city = cityById[day.cityId]
          const country = day.countryId ? countryById[day.countryId] : undefined
          if (!city || !country) return null

          const isSelected = day.id === selectedDayId
          const year = day.date.slice(0, 4)
          const showYear = index === 0 || orderedDays[index - 1]?.date.slice(0, 4) !== year

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
                  <span>{day.date}</span>
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
