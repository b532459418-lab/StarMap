/** The view rows of the editor and display lists, written by difference (3C-4a's algorithms, moved here from
 * ./diffV2.ts by 3C-5 C1 without change): diffV2ToCommands writes the lists a V2 write changed, and the store-native view
 * operations (../editor/native/editorView.ts) write the lists they changed, with the same rows and positions.
 *
 * - A list (`listScope`): its elements are view items (a target that resolves) and unresolved settings (the raw value at
 *   a position), ordered by position. The longest run of rows still in order keeps its positions; the others move between
 *   their kept neighbours, so a drag updates only the rows whose position changes. When a run cannot get positions the
 *   scope is renumbered with listPositions in the same batch.
 * - A map of lists keyed by place id (`mapScope`): a key setting per key (a ref to the place), its list in
 *   `mapListScope(scope, key)`.
 * - One setting per key of a record of strings (`settingScope`, covers): a ref to the asset, or the raw value.
 *
 * The caller gives the rows as they are before this batch (`ViewListRows`) and collects the writes (`ViewListSink`):
 * removals of view rows go first in a batch (nothing refers to a view row, and removing them frees their unique keys).
 *
 * Constraint: Node 24 loads it directly (erasable-only TypeScript, relative imports with `.ts`, `import type` for types).
 */
import type { ViewItem, ViewSetting } from '../../worldgraph/store/formal.ts'
import { positionBetween } from '../../worldgraph/store/position.ts'
import { StoreError } from '../../worldgraph/store/primitives.ts'
import type { JsonValue } from '../../worldgraph/store/types.ts'
import { UNRESOLVED_KEY_PREFIX, VIEW_SCOPES, mapListScope } from './officialDefinitions.ts'
import { listPositions, resolveListElements, unresolvedSetting, viewItemRow, viewSettingRow, type ViewTarget } from './v2RecordRows.ts'

type ViewTable = 'viewItems' | 'viewSettings'
/** The view rows before this batch. */
export interface ViewListRows {
  viewScope(scope: string): { readonly items: readonly ViewItem[]; readonly settings: readonly ViewSetting[] }
  /** The setting of `scope` with `key`, if any. */
  setting(scope: string, key: string): ViewSetting | undefined
}
/** Where the writes go. */
export interface ViewListSink {
  create(table: ViewTable, row: ViewItem | ViewSetting): void
  /** Update `current` to `desired` when they differ (revision ignored). */
  update(table: ViewTable, current: ViewItem | ViewSetting, desired: ViewItem | ViewSetting): void
  /** Remove a row (once). */
  remove(table: ViewTable, row: ViewItem | ViewSetting): void
  /** True when this batch already removes the row. */
  removes(table: ViewTable, id: string): boolean
  /** A fresh id for a new view row of `scope`. */
  newRowId(scope: string): string
  /** The id of a new key setting (`scope`, `key`). */
  settingId(scope: string, key: string): string
  /** `scope` was renumbered in this batch. */
  renumbered(scope: string): void
}
export type Resolve = (value: unknown) => ViewTarget | undefined

const text = (value: unknown): string => JSON.stringify(value)
const plain = (v: unknown): v is Record<string, JsonValue> => v !== null && typeof v === 'object' && !Array.isArray(v)
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const isPosition = (error: unknown) => error instanceof StoreError && error.code === 'E_POSITION'

/** The three writers over `rows` into `sink` (see the file header). */
export function viewListWriter(rows: ViewListRows, sink: ViewListSink) {
  /**
   * An editor or display list: its elements are view items and unresolved settings ordered by position. The longest
   * run of rows still in order keeps its positions; the others move between their kept neighbours.
   */
  function listScope(scope: string, beforeValues: readonly unknown[], afterValues: readonly unknown[], resolveBefore: Resolve,
    resolveAfter: Resolve, hidden: boolean, layerId?: string) {
    if (text(beforeValues) === text(afterValues)) return
    const scoped = rows.viewScope(scope)
    type Current = { readonly row: ViewItem | ViewSetting; readonly position: string; readonly value: unknown; readonly item: boolean }
    const current: Current[] = []
    for (const row of scoped.items) {
      const target = resolveBefore(row.itemId)
      if (target && target.table === row.itemTable && !sink.removes('viewItems', row.id)) current.push({ row, position: row.position, value: row.itemId, item: true })
    }
    for (const row of scoped.settings) {
      const v = row.value
      if (row.key.startsWith(UNRESOLVED_KEY_PREFIX) && plain(v) && typeof v.position === 'string' && Object.hasOwn(v, 'id')) current.push({ row, position: v.position, value: v.id, item: false })
    }
    current.sort((x, y) => compare(x.position, y.position) || compare(x.row.id, y.row.id))
    const elements = resolveListElements(afterValues, resolveAfter)
    // Match every element with a current row: an item by its target, an unresolved element by its value, in order.
    const byTarget = new Map<string, number>(), byValue = new Map<string, number[]>()
    current.forEach((c, index) => {
      if (c.item) byTarget.set(text([(c.row as ViewItem).itemTable, c.value]), index)
      else { const list = byValue.get(text(c.value)) ?? []; list.push(index); byValue.set(text(c.value), list) }
    })
    const matched = elements.map(({ value, target }) => {
      if (target) { const index = byTarget.get(text([target.table, target.id])); if (index !== undefined) byTarget.delete(text([target.table, target.id])); return index }
      return byValue.get(text(value))?.shift()
    })
    const keep = longestIncreasing(matched)
    const used = new Set(matched.filter((index): index is number => index !== undefined))
    current.forEach((c, index) => { if (!used.has(index)) sink.remove(c.item ? 'viewItems' : 'viewSettings', c.row) })
    const positions = positionsForRuns(elements.length, (i) => keep.has(i), (i) => current[matched[i]!].position)
    let numbers: readonly string[] | undefined
    if (!positions) { sink.renumbered(scope); numbers = listPositions(elements.length) }
    elements.forEach(({ value, target }, i) => {
      const index = matched[i]
      const position = numbers ? numbers[i] : positions!.get(i) ?? current[index!].position
      const existing = index === undefined ? undefined : current[index]
      if (target) {
        if (existing) sink.update('viewItems', existing.row, viewItemRow(scope, existing.row.id, target, position, hidden, layerId))
        else sink.create('viewItems', viewItemRow(scope, sink.newRowId(scope), target, position, hidden, layerId))
        return
      }
      // An unresolved element's key is its position: moving it is a new row (keys stay unique within the batch).
      if (existing && existing.position === position) return
      if (existing) sink.remove('viewSettings', existing.row)
      sink.create('viewSettings', unresolvedSetting(scope, sink.newRowId(scope), position, value))
    })
  }

  /** A map of lists keyed by place id: a key setting per key (ref to the place), its list in mapListScope. */
  function mapScope(scope: string, beforeMap: Readonly<Record<string, readonly unknown[]>>, afterMap: Readonly<Record<string, readonly unknown[]>>,
    resolveBefore: Resolve, resolveAfter: Resolve, hidden: boolean) {
    if (text(beforeMap) === text(afterMap)) return
    for (const key of Object.keys(beforeMap)) {
      if (Object.hasOwn(afterMap, key)) continue
      const setting = rows.setting(scope, key)
      if (setting) sink.remove('viewSettings', setting)
      const listed = rows.viewScope(mapListScope(scope, key))
      for (const row of listed.items) sink.remove('viewItems', row)
      for (const row of listed.settings) sink.remove('viewSettings', row)
    }
    for (const [key, values] of Object.entries(afterMap)) {
      const old = Object.hasOwn(beforeMap, key) ? beforeMap[key] : undefined
      if (old === undefined) {
        const existing = rows.setting(scope, key)
        const desired = viewSettingRow(scope, existing?.id ?? sink.settingId(scope, key), key, { ref: { table: 'entities', id: key } })
        if (existing) sink.update('viewSettings', existing, desired); else sink.create('viewSettings', desired)
      }
      listScope(mapListScope(scope, key), old ?? [], values, resolveBefore, resolveAfter, hidden)
    }
  }

  /** One setting per key of a record of strings (covers): a ref to the asset, or the raw value. */
  function settingScope(scope: string, beforeMap: Readonly<Record<string, string>>, afterMap: Readonly<Record<string, string>>, resolve: Resolve) {
    if (text(beforeMap) === text(afterMap)) return
    for (const key of new Set([...Object.keys(beforeMap), ...Object.keys(afterMap)])) {
      const had = Object.hasOwn(beforeMap, key), has = Object.hasOwn(afterMap, key)
      if (had && has && beforeMap[key] === afterMap[key]) continue
      const existing = rows.setting(scope, key)
      if (!has) { if (existing) sink.remove('viewSettings', existing); continue }
      const target = resolve(afterMap[key])
      const desired = viewSettingRow(scope, existing?.id ?? sink.settingId(scope, key), key, target ? { ref: target } : { value: afterMap[key] })
      if (existing) sink.update('viewSettings', existing, desired); else sink.create('viewSettings', desired)
    }
  }

  return { listScope, mapScope, settingScope }
}
export type ViewListWriter = ReturnType<typeof viewListWriter>

/** The editor state's nine lists (the official view's editorState without the added countries and headers). */
export interface EditorListValues {
  readonly countryOrder: readonly string[]
  readonly hiddenCountryIds: readonly string[]
  readonly cityOrderByCountry: Readonly<Record<string, readonly string[]>>
  readonly hiddenCityIds: readonly string[]
  readonly mediaOrderByCity: Readonly<Record<string, readonly string[]>>
  readonly hiddenMediaIds: readonly string[]
  readonly coverMediaByCity: Readonly<Record<string, string>>
  readonly droneOrderByCity: Readonly<Record<string, readonly string[]>>
  readonly hiddenDroneMediaIds: readonly string[]
}

/**
 * The rows of the editor state's nine lists, from `before` to `after`, in diffV2's order. `place` resolves a place id
 * before and after the batch, `media` a media id.
 */
export function writeEditorLists(writer: ViewListWriter, e0: EditorListValues, e1: EditorListValues, place: { readonly before: Resolve; readonly after: Resolve }, media: Resolve): void {
  const S = VIEW_SCOPES
  writer.listScope(S.countryOrder, e0.countryOrder, e1.countryOrder, place.before, place.after, false)
  writer.listScope(S.hiddenCountries, e0.hiddenCountryIds, e1.hiddenCountryIds, place.before, place.after, true)
  writer.mapScope(S.cityOrderByCountry, e0.cityOrderByCountry, e1.cityOrderByCountry, place.before, place.after, false)
  writer.listScope(S.hiddenCities, e0.hiddenCityIds, e1.hiddenCityIds, place.before, place.after, true)
  writer.mapScope(S.mediaOrderByCity, e0.mediaOrderByCity, e1.mediaOrderByCity, media, media, false)
  writer.listScope(S.hiddenMedia, e0.hiddenMediaIds, e1.hiddenMediaIds, media, media, true)
  writer.settingScope(S.coverMediaByCity, e0.coverMediaByCity, e1.coverMediaByCity, media)
  writer.mapScope(S.droneOrderByCity, e0.droneOrderByCity, e1.droneOrderByCity, media, media, false)
  writer.listScope(S.hiddenDroneMedia, e0.hiddenDroneMediaIds, e1.hiddenDroneMediaIds, media, media, true)
}

/**
 * New positions for the elements that are not kept, between their kept neighbours (`kept` positions must increase).
 * `keptPosition` is asked only for the kept neighbours of a run (null: that element has no position). Undefined when
 * a run cannot get positions: the caller renumbers the scope.
 */
export function positionsForRuns(count: number, kept: (index: number) => boolean, keptPosition: (index: number) => string | null): Map<number, string> | undefined {
  const out = new Map<number, string>()
  for (let start = 0; start < count;) {
    if (kept(start)) { start++; continue }
    let end = start
    while (end + 1 < count && !kept(end + 1)) end++
    const lower = start > 0 ? keptPosition(start - 1) : undefined
    const upper = end + 1 < count ? keptPosition(end + 1) : undefined
    if (lower === null || upper === null) return undefined
    let previous = lower
    try {
      for (let i = start; i <= end; i++) { previous = positionBetween(previous, upper); out.set(i, previous) }
    } catch (error) {
      if (isPosition(error)) return undefined
      throw error
    }
    start = end + 1
  }
  return out
}

/** Indices (into `values`) of a longest strictly increasing subsequence of the defined values. */
export function longestIncreasing(values: readonly (number | undefined)[]): Set<number> {
  const tails: number[] = [], previous = new Array<number>(values.length).fill(-1)
  values.forEach((value, i) => {
    if (value === undefined) return
    let lo = 0, hi = tails.length
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (values[tails[mid]]! < value) lo = mid + 1; else hi = mid }
    if (lo > 0) previous[i] = tails[lo - 1]
    tails[lo] = i
  })
  const kept = new Set<number>()
  for (let i = tails.length ? tails[tails.length - 1] : -1; i >= 0; i = previous[i]) kept.add(i)
  return kept
}
