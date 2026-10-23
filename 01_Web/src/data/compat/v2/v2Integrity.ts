/**
 * The integrity check of the five V2 files (RFC-LOC-1 PR3b-2 spec §2.1; 3C-5 E: moved here from the retired V2 write
 * layer, design 3C-5 §7): the empty-file templates, every place reference, and `integrityProblems` (validateV2Files
 * plus dangling place references). For V2 files only: a backup, a recovery check or a V2 import of a root that holds
 * V2 files, and tests. The store's rows are checked by Core.
 *
 * Constraint: Node 24 loads it directly (erasable-only TypeScript, relative imports with `.ts`, `import type` for types).
 *
 * Compat (3C-5 E spec §2.4; moved here from ../canonical/): the integrity check of V2 files (backups and recovery
 * checks of roots that hold V2 files).
 * V2 files are read and written only to migrate a library, to show a root that awaits migration (read-only), and to
 * export a library to V2 (store:export-v2). Ordinary read and write code does not import this directory
 * (scripts/compat-boundary.test.mjs).
 */

import type { PlaceId } from '../../canonical/types.ts'
import {
  EDITOR_STATE_SCHEMA_VERSION,
  MEDIA_SCHEMA_VERSION,
  PLACES_SCHEMA_VERSION,
  TRAVEL_SCHEMA_VERSION,
  V2_FILE_KEYS,
  WANT_TO_GO_SCHEMA_VERSION,
  validateV2Files,
  type V2FileKey,
  type V2Files,
} from './v2Schema.ts'
import { jsonClone } from './v2Serializer.ts'

/** `data/v2/` 下五个文件的原始 JSON 值；缺的文件为 undefined（或不出现）。 */
export type V2FilesOrEmpty = Partial<Record<V2FileKey, unknown>>

/**
 * 全新 V2 目录里「写时创建」的五个空文件（PR3b-2 规格 §2.1）。足迹：`schema_version: 2`、
 * `privacy_level: 'private-local'`（同旧编辑器新建私人足迹文件时的写法）、显示规则全空；想去：
 * `privacy_level: 'local-only'`（同旧想去 store 新建文件时的写法）；其余按 PR3a 的格式与版本号。
 * 时间字段取 `now`（缺的文件按空文件补齐时用）。
 */
export const emptyV2FilesForWrite = (now: Date): V2Files => {
  const iso = now.toISOString()
  return {
    places: { schema_version: PLACES_SCHEMA_VERSION, generated_at: iso, places: [] },
    travel: {
      schema_version: TRAVEL_SCHEMA_VERSION,
      generated_at: iso,
      privacy_level: 'private-local',
      display: { homeHiddenCountryIds: [], originCountryIds: [], regionCountryIds: [], regionIncludes: [], navigationHiddenCityIds: [] },
      records: [],
    },
    wantToGo: { schema_version: WANT_TO_GO_SCHEMA_VERSION, generated_at: iso, privacy_level: 'local-only', items: [] },
    editorState: {
      schemaVersion: EDITOR_STATE_SCHEMA_VERSION,
      addedCountries: [],
      countryOrder: [],
      hiddenCountryIds: [],
      cityOrderByCountry: {},
      hiddenCityIds: [],
      mediaOrderByCity: {},
      hiddenMediaIds: [],
      coverMediaByCity: {},
      droneOrderByCity: {},
      hiddenDroneMediaIds: [],
      updatedAt: iso,
    },
    media: { schemaVersion: MEDIA_SCHEMA_VERSION, items: [] },
  }
}

/** 缺的文件换成空模板；在的文件深拷贝（包括不合法的，留给完整性检查报错）。 */
export const completeForWrite = (files: V2FilesOrEmpty | undefined, now: Date): Record<V2FileKey, unknown> => {
  const empty = emptyV2FilesForWrite(now)
  return Object.fromEntries(
    V2_FILE_KEYS.map((key) => [key, files?.[key] === undefined ? empty[key] : jsonClone(files[key])]),
  ) as Record<V2FileKey, unknown>
}

// ---------------------------------------------------------------------------
// 地点引用与完整性
// ---------------------------------------------------------------------------

/** 一处地点引用：在哪个文件、哪个位置（字段或 `字段.键`），引用的 id。 */
export interface PlaceRef {
  file: V2FileKey
  where: string
  id: PlaceId
}

/**
 * 五个文件里【全部】地点引用（与原 ../canonical/placeIds.ts 列的位置相同，另加 `partOf`；那个模块随迁移工具在 PR5b 删除）。
 * 输入须已通过 `validateV2Files` 的结构检查。
 */
export const placeRefs = (files: V2Files): PlaceRef[] => {
  const refs: PlaceRef[] = []
  const add = (file: V2FileKey, where: string, id: PlaceId) => refs.push({ file, where, id })
  for (const place of files.places.places) if (place.partOf !== undefined) add('places', `partOf(${place.id})`, place.partOf)
  const { display } = files.travel
  for (const id of display.homeHiddenCountryIds) add('travel', 'display.homeHiddenCountryIds', id)
  for (const id of display.originCountryIds) add('travel', 'display.originCountryIds', id)
  for (const id of display.regionCountryIds) add('travel', 'display.regionCountryIds', id)
  for (const id of display.navigationHiddenCityIds) add('travel', 'display.navigationHiddenCityIds', id)
  for (const record of files.travel.records) add('travel', `records(${record.id})`, record.placeId)
  for (const item of files.wantToGo.items) add('wantToGo', `items(${item.id})`, item.placeId)
  const state = files.editorState
  for (const entry of state.addedCountries) add('editorState', 'addedCountries', entry.placeId)
  for (const id of state.countryOrder) add('editorState', 'countryOrder', id)
  for (const id of state.hiddenCountryIds) add('editorState', 'hiddenCountryIds', id)
  for (const [countryId, cityIds] of Object.entries(state.cityOrderByCountry)) {
    add('editorState', 'cityOrderByCountry(键)', countryId)
    for (const id of cityIds) add('editorState', `cityOrderByCountry.${countryId}`, id)
  }
  for (const id of state.hiddenCityIds) add('editorState', 'hiddenCityIds', id)
  for (const id of Object.keys(state.mediaOrderByCity)) add('editorState', 'mediaOrderByCity(键)', id)
  for (const id of Object.keys(state.coverMediaByCity)) add('editorState', 'coverMediaByCity(键)', id)
  for (const id of Object.keys(state.droneOrderByCity)) add('editorState', 'droneOrderByCity(键)', id)
  for (const item of files.media.items) add('media', `items(${item.id})`, item.placeId)
  return refs
}

/** 悬空引用：引用的地点不在注册表里。 */
export const danglingPlaceRefs = (files: V2Files): PlaceRef[] => {
  const ids = new Set(files.places.places.map((place) => place.id))
  return placeRefs(files).filter((ref) => !ids.has(ref.id))
}

/**
 * 完整性检查：`validateV2Files` 的全部问题，加上悬空引用（结构合法时才查）。返回问题的简述
 * （文件、路径、问题；不含字段的值），空数组表示通过。
 */
export const integrityProblems = (files: Record<V2FileKey, unknown>): string[] => {
  const problems = validateV2Files(files).map((problem) => `${problem.file} ${problem.path}：${problem.message}`)
  if (problems.length > 0) return problems
  return danglingPlaceRefs(files as unknown as V2Files).map((ref) => `${ref.file} ${ref.where}：引用的地点不存在（${ref.id}）`)
}
