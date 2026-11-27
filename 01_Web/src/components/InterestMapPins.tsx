import { Cartesian3, Color, LabelStyle, Cartesian2 } from 'cesium'
import { memo, useMemo } from 'react'
import { Entity } from 'resium'
import { useAppSelector } from '../data/appStore'
import { filterInterests, interestPins, readInterests, type InterestFilters, type InterestPin } from '../data/interest/read'
import { isInterestLayer } from '../data/interest/templates'
import { useUiLocale } from '../i18n/useUiLocale'

const colors = {
  food: Color.fromCssColorString('#f5bd71'),
  movie: Color.fromCssColorString('#bba9fc'),
  race: Color.fromCssColorString('#71d5b8'),
}
const labelOffset = new Cartesian2(0, -18)

export const InterestMapPins = memo(function InterestMapPins({ filters, focusedId, onSelect }: {
  filters: InterestFilters; focusedId?: string; onSelect: (pin: InterestPin) => void
}) {
  const { locale } = useUiLocale()
  const model = useAppSelector((snapshot) => snapshot.model.origin === 'local' && snapshot.model.layers.some((layer) => isInterestLayer(layer.id))
    ? snapshot.model : undefined)
  const data = useMemo(() => model ? readInterests(model) : undefined, [model])
  const pins = useMemo(() => data ? interestPins(filterInterests(data.records, filters), locale === 'zh-Hans') : [], [data, filters, locale])
  return pins.map((pin) => <InterestMarker key={pin.id} pin={pin} focused={focusedId === 'interest-' + pin.id} onSelect={onSelect} />)
})

const InterestMarker = memo(function InterestMarker({ pin, focused, onSelect }: {
  pin: InterestPin; focused: boolean; onSelect: (pin: InterestPin) => void
}) {
  const position = useMemo(() => Cartesian3.fromDegrees(pin.lng, pin.lat, 200), [pin.lat, pin.lng])
  return <Entity id={'interest-' + pin.id} name={pin.title} position={position} onClick={() => onSelect(pin)}
    point={{ color: colors[pin.kind], outlineColor: Color.fromCssColorString('#17263d'), outlineWidth: 2, pixelSize: focused ? 15 : 10 }}
    label={focused ? {
      text: pin.title, pixelOffset: labelOffset, font: '600 13px sans-serif', fillColor: Color.WHITE,
      outlineColor: Color.BLACK, outlineWidth: 2, style: LabelStyle.FILL_AND_OUTLINE,
    } : undefined} />
})
