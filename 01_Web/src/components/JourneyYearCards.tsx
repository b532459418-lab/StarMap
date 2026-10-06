import { usePlaceNames } from '../i18n/usePlaceNames'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { CalendarDays, MapPin } from 'lucide-react'
import { cityById, countryById, journeyDays, shouldHideCityFromNavigation } from '../data/travelAtlas'
import type { City, Country } from '../types/travel'
import { buildBrowseTimeProjection, journeyTimeContext, type BrowseTimeProjection } from '../data/derive/browseTimeProjection'
import type { MatchedTimeRecord } from '../worldgraph/timeQuery'

type CountryYearGroup = {
  country: Country
  startDate: string
  endDate: string
  cities: City[]
  uncertain: boolean
  yearOnly: boolean
}

type YearGroup = {
  year?: number
  countries: CountryYearGroup[]
}

const buildYearGroups = (projection: BrowseTimeProjection): YearGroup[] => {
  const sources = [...projection.journeyYears, ...(projection.uncertainJourneyRecords.length
    ? [{ year: undefined, records: projection.uncertainJourneyRecords }] : [])]
  return sources.map(({ year, records }) => {
    const groups = new Map<string, MatchedTimeRecord[]>()
    for (const match of records) {
      const countryId = match.record.countryId
      if (!countryId) continue
      const entries = groups.get(countryId) ?? []
      entries.push(match)
      groups.set(countryId, entries)
    }
    const countries = [...groups].flatMap(([countryId, matches]): CountryYearGroup[] => {
      const country = countryById[countryId]
      if (!country) return []
      const cityIds = new Set(matches.map(match => match.record.placeId))
      const cities = country.cityIds.filter(cityId => cityIds.has(cityId)).map(cityId => cityById[cityId])
        .filter(city => Boolean(city) && !shouldHideCityFromNavigation(city))
      if (!cities.length) return []
      const from = matches.map(match => match.record.date.range.from).filter((date): date is string => Boolean(date)).sort()[0] ?? ''
      const endDates = matches.map(match => match.record.date.range.to).filter((date): date is string => Boolean(date)).sort()
      return [{ country, cities, startDate: from, endDate: endDates.at(-1) ?? '',
        uncertain: matches.some(match => match.result.match === 'uncertain'),
        yearOnly: matches.some(match => match.record.date.precision === 'year'),
      }]
    }).sort((left, right) => left.startDate.localeCompare(right.startDate))
    return { year, countries }
  }).filter(group => group.countries.length > 0)
}

export function JourneyYearCards({ projection }: { projection?: BrowseTimeProjection } = {}) {
  const { t } = useTranslation(['details', 'editor', 'journey'])
  const { name, subtitle } = usePlaceNames()
  const yearGroups = useMemo(() => buildYearGroups(projection ?? buildBrowseTimeProjection(journeyTimeContext(journeyDays, cityById), {})), [projection])
  const unknownDate = t('journey:unknownDate')
  const uncertainDate = t('journey:uncertainDate')
  const yearOnly = t('journey:includesYearOnly')
  const emptyLabel = t('journey:noMatchingVisits')
  return (
    <section className="journey-view-section mx-auto w-full max-w-7xl px-5 pb-24 sm:px-8">
      <div className="space-y-[18px]">
        {yearGroups.length === 0 ? <p className="text-sm text-slate-500">{emptyLabel}</p> : null}
        {yearGroups.map((yearGroup) => (
          <section key={yearGroup.year ?? 'uncertain'} className="journey-year-group p-5 sm:p-6">
            <div className="mb-5 flex items-center gap-3">
              <span className="grid size-10 place-items-center rounded-full border border-white/70 bg-white/55 text-slate-500 shadow-sm">
                <CalendarDays className="size-4" />
              </span>
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">
                  {t('journey:travelYear')}</p>
                <h3 className="text-3xl font-semibold tracking-normal text-slate-950">
                  {yearGroup.year === undefined ? unknownDate : String(yearGroup.year).padStart(4, '0')}
                </h3>
              </div>
            </div>

            <div className="selector-scrollbar flex snap-x gap-4 overflow-x-auto pb-3">
              {yearGroup.countries.map((countryGroup) => {
                const { country } = countryGroup
                const dateRange = yearGroup.year === undefined ? unknownDate : countryGroup.startDate === countryGroup.endDate
                  ? countryGroup.startDate
                  : `${countryGroup.startDate} - ${countryGroup.endDate}`

                return (
                  <article
                    key={`${yearGroup.year}-${country.id}`}
                    className="journey-country-card min-h-[260px] w-[290px] shrink-0 snap-start rounded-[24px] border border-white/70 bg-white/48 p-5 shadow-[0_18px_50px_rgba(15,23,42,0.08)] backdrop-blur-xl transition duration-300 hover:-translate-y-1 hover:bg-white/65 hover:shadow-[0_24px_60px_rgba(15,23,42,0.12)]"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex min-w-0 items-center gap-3">
                        <span className="journey-year-card-flag" aria-hidden="true">
                          {country.flagCode ? (
                            <img
                              alt=""
                              src={`https://flagcdn.com/w80/${country.flagCode}.png`}
                            />
                          ) : (
                            <span>{country.flag ?? '\u2022'}</span>
                          )}
                        </span>
                        <div className="min-w-0">
                          <h4 className="truncate text-xl font-semibold tracking-normal text-slate-950">
                            {name(country)}
                          </h4>
                          <p className="mt-0.5 truncate text-sm font-medium text-slate-500">
                            {subtitle(country)}
                          </p>
                        </div>
                      </div>
                      <span
                        className="mt-1 size-3 rounded-full shadow-[0_0_18px_var(--country-color)]"
                        style={{ backgroundColor: country.accent, '--country-color': country.accent } as React.CSSProperties}
                        aria-hidden="true"
                      />
                    </div>

                    <p className="mt-4 text-xs font-medium text-slate-400">{dateRange}{countryGroup.yearOnly ? ` · ${yearOnly}` : ''}{countryGroup.uncertain ? ` · ${uncertainDate}` : ''}</p>

                    <div className="mt-5 space-y-2">
                      {countryGroup.cities.map((city) => (
                        <div
                          key={city.id}
                          className="flex items-start gap-2.5 text-sm leading-5 text-slate-700"
                        >
                          <MapPin className="mt-0.5 size-3.5 shrink-0 text-sky-500" />
                          <p>
                            <span className="font-semibold">{name(city)}</span>{' '}
                            <span className="text-slate-400">{subtitle(city)}</span>
                          </p>
                        </div>
                      ))}
                    </div>
                  </article>
                )
              })}
            </div>
          </section>
        ))}
      </div>
    </section>
  )
}
