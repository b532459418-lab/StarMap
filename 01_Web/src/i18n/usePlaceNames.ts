import { worldGraphSnapshot } from '../data/worldGraph'
import { localizedPlaceNames, type NamedPlace } from './placeNames.ts'
import { useUiLocale } from './useUiLocale'

const titles = new Map(worldGraphSnapshot.entities.map((entity) => [entity.id, entity.title]))

export function usePlaceNames() {
  const { locale } = useUiLocale()
  const names = (place: NamedPlace) => localizedPlaceNames(place.id ? titles.get(place.id) : undefined, place, locale)
  return { name: (place: NamedPlace) => names(place).name, subtitle: (place: NamedPlace) => names(place).subtitle }
}
