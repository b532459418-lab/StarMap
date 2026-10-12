import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { placeChoiceNames, type PlaceChoiceCandidate, type PlaceChoiceSelection } from '../data/placeChoice.ts'

type PlaceChoiceListProps = {
  candidates: readonly PlaceChoiceCandidate[]
  selected?: PlaceChoiceSelection
  /** 「新建独立地点：<输入的名字>」里显示的名字。 */
  newPlaceName: string
  disabled?: boolean
  onSelect: (selection: PlaceChoiceSelection) => void
}

/**
 * 同名城市的地点选择（第 2A 批）：在原来的对话框里内联的单选列表，不弹新窗口。
 * 每个已有地点显示中英文名与「距离约 N km」或「无坐标」，强候选另外标明；最后一项是「新建独立地点」。
 * 默认选中由调用方决定（有强候选时选中第一个，否则不预选）。
 */
export function PlaceChoiceList({ candidates, selected, newPlaceName, disabled = false, onSelect }: PlaceChoiceListProps) {
  const { t } = useTranslation('editor')
  const group = useId()
  const meta = (candidate: PlaceChoiceCandidate) => [
    candidate.distanceKm !== undefined
      ? t('placeChoiceDistance', { km: Math.round(candidate.distanceKm) })
      : candidate.hasLocation ? undefined : t('placeChoiceNoCoordinates'),
    candidate.strong ? t('placeChoiceStrong') : undefined,
  ].filter(Boolean).join(' · ')
  return (
    <fieldset className="atlas-place-choice" data-testid="place-choice">
      <legend>{t('placeChoiceTitle')}</legend>
      {candidates.map((candidate) => (
        <label key={candidate.placeId} className="atlas-place-choice-option" data-place-id={candidate.placeId} data-strong={candidate.strong}>
          <input
            type="radio"
            name={group}
            value={candidate.placeId}
            checked={selected?.kind === 'existing' && selected.placeId === candidate.placeId}
            disabled={disabled}
            onChange={() => onSelect({ kind: 'existing', placeId: candidate.placeId })}
          />
          <span>
            <strong>{t('placeChoiceExisting', { names: placeChoiceNames(candidate) })}</strong>
            {meta(candidate) ? <small>{meta(candidate)}</small> : null}
          </span>
        </label>
      ))}
      <label className="atlas-place-choice-option" data-place-choice="new">
        <input
          type="radio"
          name={group}
          value="new"
          checked={selected?.kind === 'new'}
          disabled={disabled}
          onChange={() => onSelect({ kind: 'new' })}
        />
        <span>
          <strong>{t('placeChoiceNew', { name: newPlaceName })}</strong>
        </span>
      </label>
    </fieldset>
  )
}
