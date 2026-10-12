import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { usePlaceNames } from '../i18n/usePlaceNames'
import { journeyDateRange, type JourneyChoiceCandidate, type JourneyChoiceSelection } from '../data/journeyChoice.ts'

type JourneyChoiceListProps = {
  candidates: readonly JourneyChoiceCandidate[]
  selected?: JourneyChoiceSelection
  disabled?: boolean
  onSelect: (selection: JourneyChoiceSelection) => void
}

/**
 * 同名行程的选择（第 2C 批）：在原来的对话框里内联的单选列表，不弹新窗口，与地点选择（PlaceChoiceList）同一种样式。
 * 每个候选一项：「加入已有行程：暑假（2024-07-01 至 07-10 · 东京、大阪）」，城市名随界面语言；最后一项「新建行程」。
 * 不预选：用户必须选一项，调用方在没有选择时禁用提交按钮。
 */
export function JourneyChoiceList({ candidates, selected, disabled = false, onSelect }: JourneyChoiceListProps) {
  const { t } = useTranslation('editor')
  const { name } = usePlaceNames()
  const group = useId()
  const detail = (candidate: JourneyChoiceCandidate) => {
    const { from, to } = journeyDateRange(candidate.startDate, candidate.endDate)
    const dates = from === undefined ? undefined : to === undefined ? from : t('journeyChoiceDates', { from, to })
    const names = candidate.cities
      .map((city) => name({ id: city.placeId, nameZh: city.nameZh, nameEn: city.nameEn }))
      .filter(Boolean)
      .join(t('journeyChoiceCitySeparator'))
    const cities = !names ? undefined
      : candidate.cityCount > candidate.cities.length ? t('journeyChoiceCityTotal', { cities: names, count: candidate.cityCount }) : names
    const text = [dates, cities].filter(Boolean).join(' · ')
    return text ? t('journeyChoiceDetail', { detail: text }) : ''
  }
  return (
    <fieldset className="atlas-place-choice" data-testid="journey-choice">
      <legend>{t('journeyChoiceTitle')}</legend>
      {candidates.map((candidate) => (
        <label key={candidate.journeyId} className="atlas-place-choice-option" data-journey-id={candidate.journeyId}>
          <input
            type="radio"
            name={group}
            value={candidate.journeyId}
            checked={selected?.kind === 'existing' && selected.journeyId === candidate.journeyId}
            disabled={disabled}
            onChange={() => onSelect({ kind: 'existing', journeyId: candidate.journeyId })}
          />
          <span>
            <strong>{t('journeyChoiceExisting', { title: candidate.title })}</strong>
            {detail(candidate) ? <small>{detail(candidate)}</small> : null}
          </span>
        </label>
      ))}
      <label className="atlas-place-choice-option" data-journey-choice="new">
        <input
          type="radio"
          name={group}
          value="new"
          checked={selected?.kind === 'new'}
          disabled={disabled}
          onChange={() => onSelect({ kind: 'new' })}
        />
        <span>
          <strong>{t('journeyChoiceNew')}</strong>
        </span>
      </label>
    </fieldset>
  )
}
