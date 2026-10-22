import { useMemo } from 'react'
import { useWorldGraph } from '../data/worldGraph'
import { localizedPlaceNames, type NamedPlace } from './placeNames.ts'
import { useUiLocale } from './useUiLocale'

export function usePlaceNames() {
  const { locale } = useUiLocale()
  // 3C-5 D: the titles follow the data on the page (a save no longer reloads it).
  const { worldGraphSnapshot } = useWorldGraph()
  const titles = useMemo(() => new Map(worldGraphSnapshot.entities.map((entity) => [entity.id, entity.title])), [worldGraphSnapshot])
  const names = (place: NamedPlace) => localizedPlaceNames(place.id ? titles.get(place.id) : undefined, place, locale)
  return { name: (place: NamedPlace) => names(place).name, subtitle: (place: NamedPlace) => names(place).subtitle }
}
