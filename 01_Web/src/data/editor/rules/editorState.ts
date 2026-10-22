/**
 * 编辑状态的判定（3C-5 C1 从 ../../v2write/editorState.ts 迁来，规则、错误码与参数不变；RFC-LOC-1 PR3b-2 规格 §2.3）：
 * 写入之后的排序、隐藏与封面里，地点 id 的类型必须对。
 *
 * `countryOrder`、`hiddenCountryIds`、`cityOrderByCountry` 的键必须是国家地点；`cityOrderByCountry` 的值、`hiddenCityIds`、
 * 三个按城市记的媒体表（`mediaOrderByCity` / `coverMediaByCity` / `droneOrderByCity`）的键必须是城市地点；任一地点 id 不存在
 * 或类型不对 → `E_UNKNOWN_PLACE_REF`（`params`：字段、id、应有与实际的类型），按上面的先后报第一个。媒体 id 不在这里查。
 * V2 写入函数（整份 PUT）与存储原生的视图操作（../native/editorView.ts）对写入之后的整份列表做同一个检查。
 *
 * 约束：Node 24 能直接加载——erasable-only TypeScript，相对 import 带 `.ts`，类型用 `import type`。
 */

import type { PlaceId } from '../../canonical/types.ts'
import { V2WriteError } from '../../v2write/errors.ts'

/** 编辑状态里带地点 id 的列表与表。 */
export interface EditorStatePlaceLists {
  readonly countryOrder: readonly string[]
  readonly hiddenCountryIds: readonly string[]
  readonly cityOrderByCountry: Readonly<Record<string, readonly string[]>>
  readonly hiddenCityIds: readonly string[]
  readonly mediaOrderByCity: Readonly<Record<string, readonly string[]>>
  readonly coverMediaByCity: Readonly<Record<string, string>>
  readonly droneOrderByCity: Readonly<Record<string, readonly string[]>>
}

/** 见文件头。`subtypeOf` 给出地点的类型（不存在为 undefined）。 */
export const checkEditorStatePlaces = (lists: EditorStatePlaceLists, subtypeOf: (id: PlaceId) => 'country' | 'city' | undefined): void => {
  const expect = (field: string, ids: Iterable<string>, expected: 'country' | 'city') => {
    for (const id of ids) {
      const subtype = subtypeOf(id)
      if (subtype !== expected) {
        throw new V2WriteError('E_UNKNOWN_PLACE_REF', { field, id, expected, actual: subtype ?? 'missing' })
      }
    }
  }
  expect('countryOrder', lists.countryOrder, 'country')
  expect('hiddenCountryIds', lists.hiddenCountryIds, 'country')
  expect('cityOrderByCountry', Object.keys(lists.cityOrderByCountry), 'country')
  for (const [countryId, cityIds] of Object.entries(lists.cityOrderByCountry)) expect(`cityOrderByCountry.${countryId}`, cityIds, 'city')
  expect('hiddenCityIds', lists.hiddenCityIds, 'city')
  expect('mediaOrderByCity', Object.keys(lists.mediaOrderByCity), 'city')
  expect('coverMediaByCity', Object.keys(lists.coverMediaByCity), 'city')
  expect('droneOrderByCity', Object.keys(lists.droneOrderByCity), 'city')
}
