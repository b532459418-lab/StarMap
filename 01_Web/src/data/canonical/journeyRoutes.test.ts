/**
 * 行程先后与路线类型（canonical/journeyRoutes.ts，审查 C3）的单元测试，以及它在派生、时间查询与只读存储桥上的效果。
 *
 * 运行方式：npm test。零依赖：Node 24 自带类型剥离，只用 node:test + node:assert/strict。
 * 数据是 V2 写入测试的中性个人模式文件（../editor/fixtures/migrated-files.json）：一个行程依次经过冰岛的雷克雅未克、
 * 维克（editor 隐藏）、阿克雷里，再到法罗群岛的托尔斯港、杰格夫、克拉克斯维克。
 */

/// <reference types="node" />

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { deriveTimeQueryContext } from '../derive/timeQueryContext.ts'
import { migratedFiles, placeNamed } from '../editor/editor.fixture.ts'
import { deriveAppDataFromCanonical } from './derive.ts'
import { compareCodePoints, compareJourneyRecords, routeTypeBetween } from './journeyRoutes.ts'
import { bridgeV2 } from './storeBridge.ts'
import { projectBridgeOriginalRoutes } from './storeBridgeProjection.ts'
import { sequentialUuids } from './v2.fixture.ts'
import { readV2 } from './v2Reader.ts'
import type { V2Files } from './v2Schema.ts'

const NOW = '2000-01-01T00:00:00.000Z'

test('compareCodePoints：按 Unicode 码点，不按 UTF-16 码元，也不受 locale 影响', () => {
  assert.equal(compareCodePoints('a', 'a'), 0)
  assert.equal(compareCodePoints('a', 'ab'), -1)
  assert.equal(compareCodePoints('ab', 'a'), 1)
  // 大写字母的码点比小写小（localeCompare 在 en 里把 a 排在 B 前面）。
  assert.equal(compareCodePoints('B', 'a'), -1)
  // 码点高于 U+FFFF 的字符（UTF-16 里是代理对，首个码元 0xD83D）排在 U+FF5E 之后。
  const astral = String.fromCodePoint(0x1f600)
  const bmpHigh = String.fromCodePoint(0xff5e)
  assert.equal(astral < bmpHigh, true, '按 UTF-16 码元比较时代理对在前')
  assert.equal(compareCodePoints(bmpHigh, astral), -1)
  assert.equal(compareCodePoints(`x${astral}`, `x${bmpHigh}`), 1)
})

test('compareJourneyRecords：结果与运行环境的 locale 无关', () => {
  const records = [
    { id: 'y', start_date: '2025-06-01' },
    { id: 'j', start_date: '2025-06-01' },
    { id: 'a_b', start_date: '2025-06-02' },
    { id: 'a-b', start_date: '2025-06-02' },
    { id: 'B', start_date: '2025-06-02' },
    { id: 'early', start_date: '2025' },
    { id: 'no-date' },
  ]
  // `2025-06-…` 排在 `2025-early` 前面（'0' < 'e'）；没有日期的键以 `undefined-` 开头，排在最后。
  const expected = ['j', 'y', 'B', 'a-b', 'a_b', 'early', 'no-date']
  assert.deepEqual([...records].sort(compareJourneyRecords).map((record) => record.id), expected)
  assert.deepEqual([...records].reverse().sort(compareJourneyRecords).map((record) => record.id), expected)
  // 对照：localeCompare 的结果随 locale 改变（立陶宛语把 y 排在 i 与 j 之间），这正是不再用它的原因。
  const byLocale = (locale: string) => ['j', 'y'].sort((left, right) => left.localeCompare(right, locale))
  assert.deepEqual(byLocale('en'), ['j', 'y'])
  if (Intl.Collator.supportedLocalesOf(['lt']).length > 0) assert.deepEqual(byLocale('lt'), ['y', 'j'])
})

test('routeTypeBetween：同一个国家 id 为 main，不同为 flight；两端都查不到国家时仍算同一个', () => {
  assert.equal(routeTypeBetween('country-a', 'country-a'), 'main')
  assert.equal(routeTypeBetween('country-a', 'country-b'), 'flight')
  assert.equal(routeTypeBetween('country-a', undefined), 'flight')
  assert.equal(routeTypeBetween(undefined, undefined), 'main')
  assert.equal(routeTypeBetween('', undefined), 'main')
})

/** 冰岛与法罗群岛都只剩中文名。 */
const chineseNamesOnly = (): V2Files => {
  const files = migratedFiles()
  for (const name of ['Iceland', 'Faroe Islands']) delete placeNamed(files, name, 'country').names.en
  return files
}

test('两个国家都只有中文名时，跨国路线是 flight（派生、时间查询与存储桥一致）；国内路线仍是 main', () => {
  const files = chineseNamesOnly()
  const iceland = placeNamed(migratedFiles(), 'Iceland', 'country').id
  const akureyri = placeNamed(files, 'Akureyri').id
  const torshavn = placeNamed(files, 'Torshavn').id
  const reykjavik = placeNamed(files, 'Reykjavik').id

  const { routes, countryIdOfCity } = deriveAppDataFromCanonical(readV2(files), { now: NOW }).travelAtlas
  assert.equal(countryIdOfCity(akureyri), iceland)
  const typeOf = (from: string, to: string) => routes.find((route) => route.fromCityId === from && route.toCityId === to)?.type
  assert.equal(typeOf(akureyri, torshavn), 'flight', '冰岛 → 法罗群岛')
  assert.equal(typeOf(reykjavik, akureyri), 'main', '冰岛国内（维克被 editor 隐藏，不在显示中的路线里）')

  const { originalRoutes } = deriveTimeQueryContext(readV2(files))
  const kindOf = (from: string, to: string) => originalRoutes.find((route) => route.fromPlaceId === from && route.toPlaceId === to)?.kind
  assert.equal(kindOf(akureyri, torshavn), 'flight')
  assert.equal(kindOf(placeNamed(files, 'Vik').id, akureyri), 'main')

  // 存储 id 的序列与迁移时的地点 id 错开。
  const document = bridgeV2(files, { now: NOW, allocateId: sequentialUuids(Date.UTC(2030, 0, 1)) })
  assert.deepEqual(projectBridgeOriginalRoutes(document), originalRoutes)
})

test('「N 个到访城市」按城市 id 计数：同一国家里两个同名城市各算一个', () => {
  const files = migratedFiles()
  const torshavn = placeNamed(files, 'Torshavn')
  const gjogv = placeNamed(files, 'Gjogv')
  gjogv.names = { ...torshavn.names }
  const faroe = deriveAppDataFromCanonical(readV2(files), { now: NOW }).travelAtlas.countryById[placeNamed(files, 'Faroe Islands').id]
  assert.equal(faroe.cityIds.length, 3)
  assert.equal(faroe.summary, '3 visited cities collected from Archive export.')
})
