/**
 * 「标记为去过」的共用规则（canonical/convertRules.ts，审查 C2）的单元测试。
 *
 * 运行方式：npm test。零依赖：Node 24 自带类型剥离，只用 node:test + node:assert/strict。
 *
 * 核心断言是「界面与服务端一致」：同一份五个 V2 文件，一边交给写入端点 `convertToTravel`（../v2write/convert.ts），
 * 一边经 V2 Reader 与派生得到界面用的 `wantToGoConvertBlockReason` / `plannedConvertBlockReason`，
 * 端点拒绝的码对应的文案必须就是界面给出的禁用原因；端点接受时界面没有禁用原因。
 * 数据是 V2 写入测试的中性个人模式文件（../editor/fixtures/migrated-files.json）。
 */

/// <reference types="node" />

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { convertToTravel } from '../v2write/convert.ts'
import { V2WriteError, messageFor, type V2WriteErrorCode } from '../editor/errors.ts'
import { migratedFiles, placeNamed, testContext } from '../v2write/v2write.fixture.ts'
import { convertRuleDataOfCanonical, convertRuleDataOfV2Files, convertRules } from './convertRules.ts'
import { deriveAppDataFromCanonical } from './derive.ts'
import type { V2Files } from './v2Schema.ts'
import { readV2 } from './v2Reader.ts'

const NOW = '2000-01-01T00:00:00.000Z'

/** 端点的结论：拒绝码，或 undefined（接受）。 */
const serverCode = (files: V2Files, body: Record<string, unknown>): V2WriteErrorCode | undefined => {
  try {
    convertToTravel(files, { startDate: '2026-09-01', ...body }, testContext())
    return undefined
  } catch (error) {
    assert.ok(error instanceof V2WriteError, String(error))
    return error.code
  }
}

const deriveFrom = (files: V2Files) => deriveAppDataFromCanonical(readV2(files), { now: NOW })

/** 想去条目：端点与界面一致，且等于预期的码。 */
const assertWantToGoParity = (files: V2Files, itemId: string, expected: V2WriteErrorCode | undefined, label: string) => {
  const code = serverCode(files, { source: 'want-to-go', id: itemId })
  assert.equal(code, expected, `${label}：端点`)
  const { wantToGo } = deriveFrom(files)
  const item = wantToGo.wantToGoItemById.get(itemId)
  assert.ok(item, `${label}：界面里有这个条目`)
  assert.equal(wantToGo.wantToGoConvertBlockReason(item), code === undefined ? undefined : messageFor(code), `${label}：界面`)
}

/** planned 记录：端点与界面一致，且等于预期的码。 */
const assertPlannedParity = (files: V2Files, recordId: string, expected: V2WriteErrorCode | undefined, label: string) => {
  const code = serverCode(files, { source: 'planned', recordId })
  assert.equal(code, expected, `${label}：端点`)
  const derived = deriveFrom(files)
  const record = derived.travelAtlas.plannedRecords.find((candidate) => candidate.id === recordId)
  assert.ok(record, `${label}：界面里有这条记录`)
  assert.equal(derived.wantToGo.plannedConvertBlockReason(record), code === undefined ? undefined : messageFor(code), `${label}：界面`)
}

/** 在一份新的迁移后文件上加一个想去条目（指向英文名为 `cityEn` 的地点），返回文件。 */
const withItem = (id: string, cityEn: string, mutate: (files: V2Files) => void = () => {}) => {
  const files = migratedFiles()
  files.wantToGo.items.push({ id, placeId: placeNamed(files, cityEn).id, addedAt: '2026-01-01', hidden: false })
  mutate(files)
  return files
}

test('想去 → 足迹：四条规则在界面与服务端的结论一致（含「城市被隐藏但有记录」「只有 planned 记录」）', () => {
  const NO_LOCATION_CITY = '019b76da-a8f4-7000-8000-0000000000f4'
  const cases: [string, V2Files, string, V2WriteErrorCode | undefined][] = [
    ['可以转换（努克：没有任何记录）', migratedFiles(), 'wtg_2026-08-12_nuuk', undefined],
    ['整个国家', withItem('w_country', 'Iceland'), 'w_country', 'E_CONVERT_COUNTRY_KIND'],
    ['城市没有坐标', (() => {
      const files = migratedFiles()
      files.places.places.push({ id: NO_LOCATION_CITY, subtype: 'city', names: { en: 'Ilulissat' }, partOf: placeNamed(files, 'Greenland').id })
      files.wantToGo.items.push({ id: 'w_no_location', placeId: NO_LOCATION_CITY, addedAt: '2026-01-01', hidden: false })
      return files
    })(), 'w_no_location', 'E_CONVERT_NO_COORDINATES'],
    // 下面四种，审查 C2 之前界面给的是 undefined（按钮可点），端点却必定拒绝。
    ['条目已隐藏', migratedFiles(), 'wtg_2026-08-12_tromso', 'E_CONVERT_HIDDEN'],
    ['城市被 editor 隐藏但有记录（维克）', withItem('w_vik', 'Vik'), 'w_vik', 'E_CONVERT_CITY_IN_FOOTPRINT'],
    ['城市只有 planned 记录（卑尔根）', withItem('w_bergen', 'Bergen'), 'w_bergen', 'E_CONVERT_CITY_IN_FOOTPRINT'],
    ['国家被 editor 隐藏（冰岛），城市有记录', withItem('w_reykjavik', 'Reykjavik', (files) => {
      files.editorState.hiddenCountryIds = [placeNamed(files, 'Iceland').id]
    }), 'w_reykjavik', 'E_CONVERT_CITY_IN_FOOTPRINT'],
    ['记录不上首页（法罗群岛在 homeHiddenCountryIds）', withItem('w_klaksvik', 'Klaksvik', (files) => {
      files.travel.display.homeHiddenCountryIds = [placeNamed(files, 'Faroe Islands').id]
    }), 'w_klaksvik', 'E_CONVERT_CITY_IN_FOOTPRINT'],
    ['城市显示中、有足迹记录（阿克雷里）', migratedFiles(), 'wtg_2026-08-12_akureyri', 'E_CONVERT_CITY_IN_FOOTPRINT'],
  ]
  for (const [label, files, itemId, expected] of cases) assertWantToGoParity(files, itemId, expected, label)
})

test('想去 → 足迹：检查顺序与端点相同（整个国家先于隐藏；没有坐标先于隐藏；隐藏先于城市已在足迹）', () => {
  const hiddenCountry = withItem('w_country', 'Iceland', (files) => { files.wantToGo.items.at(-1)!.hidden = true })
  assertWantToGoParity(hiddenCountry, 'w_country', 'E_CONVERT_COUNTRY_KIND', '已隐藏的整个国家')
  const hiddenInFootprint = withItem('w_akureyri_hidden', 'Akureyri', (files) => { files.wantToGo.items.at(-1)!.hidden = true })
  assertWantToGoParity(hiddenInFootprint, 'w_akureyri_hidden', 'E_CONVERT_HIDDEN', '已隐藏、城市已在足迹')
  const hiddenNoLocation = withItem('w_bergen_hidden', 'Bergen', (files) => {
    delete placeNamed(files, 'Bergen').location
    files.wantToGo.items.at(-1)!.hidden = true
  })
  assertWantToGoParity(hiddenNoLocation, 'w_bergen_hidden', 'E_CONVERT_NO_COORDINATES', '已隐藏、城市没有坐标')
})

test('planned → 足迹：坐标规则在界面与服务端的结论一致（省略时看城市坐标；写了就必须两个都是有限数字）', () => {
  const withBergen = (mutate: (files: V2Files) => void) => {
    const files = migratedFiles()
    mutate(files)
    return files
  }
  const record = (files: V2Files) => files.travel.records.find((candidate) => candidate.id === 'planned_bergen')!
  const cases: [string, V2Files, V2WriteErrorCode | undefined][] = [
    ['省略坐标、城市有坐标', migratedFiles(), undefined],
    ['自己的坐标', withBergen((files) => Object.assign(record(files), { lat: 60.1, lng: 5.1 })), undefined],
    ['坐标为 null', withBergen((files) => Object.assign(record(files), { lat: null, lng: null })), 'E_PLANNED_NO_COORDINATES'],
    ['只写了纬度', withBergen((files) => Object.assign(record(files), { lat: 60.1 })), 'E_PLANNED_NO_COORDINATES'],
    ['省略坐标、城市也没有坐标', withBergen((files) => { delete placeNamed(files, 'Bergen').location }), 'E_PLANNED_NO_COORDINATES'],
  ]
  for (const [label, files, expected] of cases) assertPlannedParity(files, 'planned_bergen', expected, label)
})

test('同一份数据：五个 V2 文件与 V2 Reader 读出的 Canonical 上，规则对每个条目与记录的结论相同；找不到的 id', () => {
  const files = withItem('w_bergen', 'Bergen', (draft) => {
    draft.travel.records.push({ id: 'planned_no_location', placeId: placeNamed(draft, 'Nuuk').id, start_date: '2027-01-01', status: 'planned', lat: null, lng: null })
  })
  const onFiles = convertRules(convertRuleDataOfV2Files(files))
  const onCanonical = convertRules(convertRuleDataOfCanonical(readV2(files)))
  for (const item of files.wantToGo.items) {
    assert.equal(onCanonical.wantToGoConvertBlockCode(item.id), onFiles.wantToGoConvertBlockCode(item.id), item.id)
  }
  for (const record of files.travel.records) {
    assert.equal(onCanonical.plannedConvertBlockCode(record.id), onFiles.plannedConvertBlockCode(record.id), record.id)
  }
  assert.equal(onFiles.wantToGoConvertBlockCode('missing'), 'E_WTG_NOT_FOUND')
  assert.equal(onFiles.plannedConvertBlockCode('missing'), 'E_PLANNED_NOT_FOUND')
  assert.equal(onFiles.plannedConvertBlockCode('sample_vik'), 'E_PLANNED_NOT_FOUND', '不是 planned')
  assert.equal(onFiles.plannedConvertBlockCode('planned_no_location'), 'E_PLANNED_NO_COORDINATES')
})
