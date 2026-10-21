/** The official reader (3C-5 C1, design 3C-5 §3): the questions the store-native editor rules ask about the official
 * data, answered from a read model index (the host's live index) and never by projecting the whole store.
 *
 * Every answer is what the official view (./projectCanonical.ts) would give for the same rows: places, want-to-go
 * items and the editor lists are built by the projection's own functions (placeValueOf, wishValueOf, editorListsOf),
 * and orders follow its rules (the original-order scopes first, by position; then rows without a position).
 * - Places: one place (`place`), its subtype; every country in the official order (`countries`, for the country
 *   resolution); the cities of a country (`citiesOf`, for the city candidates).
 * - Want-to-go items: by their V2 id (`wish`), on a place (`wishesOn`); each with its entry and hidden view row.
 * - The editor state's lists (`editorLists`) and the rows of a view scope (`scope`).
 * - References to a place from any row of any layer (`placeReferences`, for the cleanup of unreferenced places).
 *
 * Constraint: Node 24 loads it directly (erasable-only TypeScript, relative imports with `.ts`, `import type` for types).
 */
import type { ViewItem, ViewSetting } from '../../worldgraph/store/formal.ts'
import type { Ref } from '../../worldgraph/store/reader.ts'
import type { LayerEntry, StoreEntity } from '../../worldgraph/store/types.ts'
import type { ReadModelIndex } from '../../worldgraph/readModel/lookup.ts'
import type { ReadModelTable } from '../../worldgraph/readModel/types.ts'
import type { CanonicalEditorState, CanonicalPlace, CanonicalWantToGoItem } from '../canonical/types.ts'
import { OFFICIAL, VIEW_SCOPES } from './officialDefinitions.ts'
import { editorListsOf, officialEntryRole, placeValueOf, recordIdOf, wishValueOf, type ViewScopeAccess } from './projectCanonical.ts'

/** The index the reader needs: lookups, and reverse references (the host's live index has them). */
export interface OfficialReaderIndex extends ReadModelIndex {
  referencesTo?(table: ReadModelTable, id: string): readonly Ref[]
}

/** A want-to-go item with its rows. */
export interface OfficialWish {
  readonly entry: LayerEntry
  /** The Canonical item (the official view's value). */
  readonly item: CanonicalWantToGoItem
  /** Its row in the hidden scope (the first by id, as the projection reads it), if any. */
  readonly hiddenRow?: ViewItem
}

export type EditorLists = Omit<CanonicalEditorState, 'schemaVersion' | 'addedCountries' | 'updatedAt'>

export interface OfficialReader {
  readonly index: OfficialReaderIndex
  place(id: string): CanonicalPlace | undefined
  subtypeOf(id: string): 'country' | 'city' | undefined
  /** Every country, in the official order. */
  countries(): readonly CanonicalPlace[]
  /** The cities whose country (first part-of relation to a place) is `countryId`, in the official order. */
  citiesOf(countryId: string): readonly CanonicalPlace[]
  /** The want-to-go item with this V2 id, if any. */
  wish(id: string): OfficialWish | undefined
  /** The want-to-go items on a place (hidden ones too). */
  wishesOn(placeId: string): readonly OfficialWish[]
  /** The editor state's lists (the official view's editorState without the added countries and headers). */
  editorLists(): EditorLists
  /** The items and settings of one view scope. */
  scope(scope: string): { readonly items: readonly ViewItem[]; readonly settings: readonly ViewSetting[] }
  /** The view item of `scope` that targets `table`/`id`, if any. */
  viewItem(scope: string, table: 'entities' | 'entries' | 'assets', id: string): ViewItem | undefined
  /** The setting of `scope` with `key`, if any. */
  viewSetting(scope: string, key: string): ViewSetting | undefined
}

const byPositionThenId = (a: { position: string; id: string }, b: { position: string; id: string }) =>
  (a.position < b.position ? -1 : a.position > b.position ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/** The official reader of `index` (see the file header). Answers are cached for the reader's lifetime (one write). */
export function officialReader(index: OfficialReaderIndex): OfficialReader {
  const places = new Map<string, CanonicalPlace | undefined>()
  const isPlaceEntity = (id: string) => (index.get('entities', id) as StoreEntity | undefined)?.typeId === OFFICIAL.place
  const place = (id: string): CanonicalPlace | undefined => {
    if (places.has(id)) return places.get(id)
    const entity = index.get('entities', id) as StoreEntity | undefined
    let value: CanonicalPlace | undefined
    if (entity?.typeId === OFFICIAL.place) {
      const built = placeValueOf(entity) as Record<string, unknown>
      // The projection's part-of: the first part-of relation (by id) to a place; its location: the first location anchor.
      const parent = index.relationsFrom(id, OFFICIAL.partOf).find((relation) => isPlaceEntity(relation.toEntityId))
      if (parent) built.partOf = parent.toEntityId
      const anchor = index.anchorsOf(id).find((row) => row.kind === 'location')
      if (anchor?.kind === 'location') built.location = { lat: anchor.lat, lng: anchor.lng, ...(anchor.approximate === true ? { approximate: true } : {}) }
      value = built as unknown as CanonicalPlace
    }
    places.set(id, value)
    return value
  }
  /** Places in the official order: positioned in placeOrder first (position, then row id), then by entity id. */
  const inOfficialOrder = (ids: readonly string[]): CanonicalPlace[] => {
    const at = new Map<string, ViewItem>()
    for (const item of index.viewItemsOf(VIEW_SCOPES.placeOrder)) if (item.itemTable === 'entities' && !at.has(item.itemId)) at.set(item.itemId, item)
    return [...ids].sort((a, b) => {
      const x = at.get(a), y = at.get(b)
      if (x && y) return byPositionThenId(x, y)
      if (x || y) return x ? -1 : 1
      return a < b ? -1 : a > b ? 1 : 0
    }).map((id) => place(id)!)
  }
  let countryList: readonly CanonicalPlace[] | undefined
  const scopeAccess: ViewScopeAccess = { items: (scope) => index.viewItemsOf(scope), settings: (scope) => index.viewSettingsOf(scope) }
  let lists: EditorLists | undefined
  let wishes: { byId: Map<string, OfficialWish>; byPlace: Map<string, OfficialWish[]> } | undefined
  const wishIndex = () => {
    if (wishes) return wishes
    const hidden = new Map<string, ViewItem>()
    for (const item of [...index.viewItemsOf(VIEW_SCOPES.wantToGoHidden)].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
      if (item.itemTable === 'entries' && !hidden.has(item.itemId)) hidden.set(item.itemId, item)
    }
    const byId = new Map<string, OfficialWish>(), byPlace = new Map<string, OfficialWish[]>()
    for (const entry of index.entriesOfLayer(OFFICIAL.wantToGo)) {
      if (officialEntryRole(entry) !== 'wish' || !place(entry.entityId)) continue
      const hiddenRow = hidden.get(entry.id)
      const wish: OfficialWish = { entry, item: wishValueOf(entry, hiddenRow?.hidden) as unknown as CanonicalWantToGoItem, ...(hiddenRow ? { hiddenRow } : {}) }
      // The projection keeps every entry; two with one V2 id would both show. The first by entry id answers here.
      if (!byId.has(recordIdOf(entry))) byId.set(recordIdOf(entry), wish)
      const list = byPlace.get(entry.entityId) ?? []
      list.push(wish)
      byPlace.set(entry.entityId, list)
    }
    return (wishes = { byId, byPlace })
  }

  return {
    index,
    place,
    subtypeOf: (id) => {
      const subtype = place(id)?.subtype
      return subtype === 'country' || subtype === 'city' ? subtype : undefined
    },
    countries() {
      countryList ??= Object.freeze(inOfficialOrder(index.entitiesOfType(OFFICIAL.place)
        .filter((entity) => entity.fields.subtype === 'country').map((entity) => entity.id)))
      return countryList
    },
    citiesOf(countryId) {
      const ids = index.relationsTo(countryId, OFFICIAL.partOf).map((relation) => relation.fromEntityId)
        .filter((id) => place(id)?.subtype === 'city' && place(id)?.partOf === countryId)
      return Object.freeze(inOfficialOrder([...new Set(ids)]))
    },
    wish: (id) => wishIndex().byId.get(id),
    wishesOn: (placeId) => wishIndex().byPlace.get(placeId) ?? [],
    editorLists() {
      lists ??= editorListsOf(scopeAccess, (id) => place(id) !== undefined, (id) => index.get('assets', id) !== undefined) as unknown as EditorLists
      return lists
    },
    scope: (scope) => ({ items: index.viewItemsOf(scope), settings: index.viewSettingsOf(scope) }),
    viewItem: (scope, table, id) => index.viewItemsOf(scope).filter((item) => item.itemTable === table && item.itemId === id)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0],
    viewSetting: (scope, key) => index.viewSettingsOf(scope).find((setting) => setting.key === key),
  }
}
