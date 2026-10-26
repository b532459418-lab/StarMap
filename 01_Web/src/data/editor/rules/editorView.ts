/**
 * 视图操作（3C-5 C1，设计 3C-5 §3：`PUT /state` 改为 `POST /editor/view`）：页面不再「取回整份编辑状态 → 改 → 整份写回」，
 * 而是只发这次编辑做了什么，由服务端在当前的编辑状态上合并。操作的语义就是原来客户端 updater 的语义
 * （../../editorStateDelta.ts），所以没有别处的修改时，结果与原来的整份写回完全相同（双跑对照证明）：
 *
 * - `{ op: 'order', scope: 'countries', ids, baseline }`：国家顺序 = `mergeOrder(当前, ids, baseline)`（原 countryDraftUpdater）。
 * - `{ op: 'order', scope: 'cities' | 'media' | 'drone', key, ids, baseline }`：某个国家的城市顺序、某个城市的照片或航拍顺序。
 *   原来是整份替换这个键的列表（cityDraftUpdater、photoDraftUpdater、droneDraftUpdater）；现在是先去掉这次草稿相对
 *   baseline 拿掉的 id，再 `mergeOrder`：没有别处的修改时与整份替换相同，别处新加的 id 保留在后面。
 * - `{ op: 'hide', scope: 'countries' | 'cities' | 'media' | 'drone', add, remove }`：隐藏列表 = (当前 − remove) ∪ add，新加的
 *   按 add 的顺序追加在后、不重复（原 applySetDelta 与「恢复隐藏」withoutIds、「先隐藏再删除」的并集）。
 * - `{ op: 'cover', key, id }`：某个城市的封面（原 photoDraftUpdater 在有封面时写这一项）。
 *
 * 媒体 id：`isKnownMedia` 给出时，操作带来的、不存在的媒体 id 直接忽略（设计 §9 刻意改变的第 4 条，与 mergeOrder「只保留
 * 仍然存在的 id」一致）；编辑状态里原有的不动。地点 id 不在这里查：合并之后由 ./editorState.ts 的 checkEditorStatePlaces
 * 对整份列表检查，错误码与参数同原来的整份写回。请求的形状不对 → `E_EDITOR_STATE_INVALID`（`params.field` 指出是哪个操作的哪个字段）。
 *
 * 约束：Node 24 能直接加载——erasable-only TypeScript，相对 import 带 `.ts`，类型用 `import type`。
 */

import { V2WriteError } from '../errors.ts'
import { mergeOrder } from '../../editorStateDelta.ts'
import { isObject } from './input.ts'

export type ViewListScope = 'countries' | 'cities' | 'media' | 'drone'
export type ViewOperation =
  | { readonly op: 'order'; readonly scope: 'countries'; readonly ids: readonly string[]; readonly baseline: readonly string[] }
  | { readonly op: 'order'; readonly scope: 'cities' | 'media' | 'drone'; readonly key: string; readonly ids: readonly string[]; readonly baseline: readonly string[] }
  | { readonly op: 'hide'; readonly scope: ViewListScope; readonly add: readonly string[]; readonly remove: readonly string[] }
  | { readonly op: 'cover'; readonly key: string; readonly id: string }

/** The editor lists the operations change (the official view's editorState lists). */
export interface ViewLists {
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

const invalid = (field: string): never => { throw new V2WriteError('E_EDITOR_STATE_INVALID', { field }) }
const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string')
const LIST_SCOPES: readonly ViewListScope[] = ['countries', 'cities', 'media', 'drone']

/** `{ operations: [...] }` → the operations, or `E_EDITOR_STATE_INVALID` for the first malformed field. */
export function parseViewOperations(input: unknown): ViewOperation[] {
  if (!isObject(input) || !Array.isArray(input.operations)) return invalid('operations')
  if (input.operations.length === 0) return invalid('operations')
  return input.operations.map((value: unknown, index: number): ViewOperation => {
    const at = (field: string) => `operations[${index}]${field ? `.${field}` : ''}`
    if (!isObject(value)) return invalid(at(''))
    const strings = (field: string): string[] => (isStringArray(value[field]) ? [...value[field]] : invalid(at(field)))
    const text = (field: string): string => (typeof value[field] === 'string' && value[field] !== '' ? value[field] : invalid(at(field)))
    const scope = value.scope as ViewListScope
    switch (value.op) {
      case 'order':
        if (!LIST_SCOPES.includes(scope)) return invalid(at('scope'))
        if (scope === 'countries') return { op: 'order', scope, ids: strings('ids'), baseline: strings('baseline') }
        return { op: 'order', scope, key: text('key'), ids: strings('ids'), baseline: strings('baseline') }
      case 'hide':
        if (!LIST_SCOPES.includes(scope)) return invalid(at('scope'))
        return { op: 'hide', scope, add: strings('add'), remove: strings('remove') }
      case 'cover':
        return { op: 'cover', key: text('key'), id: text('id') }
      default:
        return invalid(at('op'))
    }
  })
}

/** (current − remove) ∪ add: new ids appended in `add` order, never twice. */
export function applyHide(current: readonly string[], add: readonly string[], remove: readonly string[]): string[] {
  const removed = new Set(remove)
  const result = current.filter((id) => !removed.has(id))
  const present = new Set(result)
  for (const id of add) {
    if (present.has(id)) continue
    result.push(id)
    present.add(id)
  }
  return result
}

/** A keyed order: the ids the draft removed (relative to its baseline) leave, then mergeOrder (see the file header). */
export function mergeKeyedOrder(current: readonly string[], draft: readonly string[], baseline: readonly string[]): string[] {
  const kept = new Set(draft)
  const removed = new Set(baseline.filter((id) => !kept.has(id)))
  return mergeOrder(current.filter((id) => !removed.has(id)), draft, baseline)
}

/** The hide operation of a draft against its baseline: what the draft adds and what it removes (applySetDelta's halves). */
export { setDelta as hideDelta } from '../../editorStateDelta.ts'

/**
 * The lists after the operations, applied in order to `current`. `isKnownMedia` (the native writes): media ids the
 * operations bring that are no media are dropped; without it (the page's own merge, as before) every id stays.
 */
export function applyViewOperations(current: ViewLists, operations: readonly ViewOperation[], isKnownMedia?: (id: string) => boolean): ViewLists {
  // The ids an operation brings into a media list: without the unknown ones that list does not hold yet.
  const brought = (scope: ViewListScope | 'cover', present: readonly string[]) => (ids: readonly string[]) =>
    (isKnownMedia && (scope === 'media' || scope === 'drone' || scope === 'cover') ? ids.filter((id) => isKnownMedia(id) || present.includes(id)) : [...ids])
  let next: ViewLists = current
  const hiddenField = { countries: 'hiddenCountryIds', cities: 'hiddenCityIds', media: 'hiddenMediaIds', drone: 'hiddenDroneMediaIds' } as const
  const mapField = { cities: 'cityOrderByCountry', media: 'mediaOrderByCity', drone: 'droneOrderByCity' } as const
  for (const operation of operations) {
    if (operation.op === 'order' && operation.scope === 'countries') {
      next = { ...next, countryOrder: mergeOrder(next.countryOrder, operation.ids, operation.baseline) }
    } else if (operation.op === 'order') {
      const field = mapField[operation.scope]
      const map = next[field]
      const present = map[operation.key] ?? []
      const ids = mergeKeyedOrder(present, brought(operation.scope, present)(operation.ids), operation.baseline)
      next = { ...next, [field]: { ...map, [operation.key]: ids } }
    } else if (operation.op === 'hide') {
      const field = hiddenField[operation.scope]
      next = { ...next, [field]: applyHide(next[field], brought(operation.scope, next[field])(operation.add), operation.remove) }
    } else {
      const present = next.coverMediaByCity[operation.key]
      if (brought('cover', present === undefined ? [] : [present])([operation.id]).length) {
        next = { ...next, coverMediaByCity: { ...next.coverMediaByCity, [operation.key]: operation.id } }
      }
    }
  }
  return next
}
