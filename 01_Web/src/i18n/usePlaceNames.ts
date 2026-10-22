import { useAppSelector, type AppSnapshot } from '../data/appStore'
import { localizedPlaceNames, type NamedPlace } from './placeNames.ts'
import { useUiLocale } from './useUiLocale'

type Titles = ReadonlyMap<string, unknown>
const titlesByEntities = new WeakMap<object, Titles>()
let lastTitles: Titles | undefined
/**
 * 3C-5 D: the titles of the graph's entities, the same Map as long as no title changed (a save that changes a note keeps
 * it), so that the many components that name places do not render again after every save.
 */
function titlesOf(snapshot: AppSnapshot): Titles {
  const entities = snapshot.appData.worldGraph.worldGraphSnapshot.entities
  // By the entities (a page that is not shown reads older ones, ../data/appStore.ts HoldDataWhileHidden).
  const known = titlesByEntities.get(entities)
  if (known) return known
  const next = new Map(entities.map((entity) => [entity.id, entity.title]))
  const same = lastTitles !== undefined && lastTitles.size === next.size
    && [...next].every(([id, title]) => {
      const before = lastTitles!.get(id)
      return before === title || JSON.stringify(before) === JSON.stringify(title)
    })
  const titles = same ? lastTitles! : next
  titlesByEntities.set(entities, titles)
  lastTitles = titles
  return titles
}

export function usePlaceNames() {
  const { locale } = useUiLocale()
  const titles = useAppSelector(titlesOf)
  const names = (place: NamedPlace) => localizedPlaceNames(place.id ? titles.get(place.id) as Parameters<typeof localizedPlaceNames>[0] : undefined, place, locale)
  return { name: (place: NamedPlace) => names(place).name, subtitle: (place: NamedPlace) => names(place).subtitle }
}
