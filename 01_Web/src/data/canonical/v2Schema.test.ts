/**
 * V2 文件校验（canonical/v2Schema.ts）的单元测试（RFC-LOC-1 PR3a 规格 §2.2、§4）。
 *
 * 运行方式：npm test。零依赖：Node 24 自带类型剥离，只用 node:test + node:assert/strict。
 *
 * 合法样本：公开样例经 Legacy Adapter 后直接搬进 V2 的 id 空间（`toV2Space`，不合并）再写成五个文件。
 * 非法样本：在合法样本上逐项改坏，断言问题落在预期的文件与路径上。
 */

/// <reference types="node" />

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { consistentPersonalRaw, sampleRaw } from './legacy.fixture.ts'
import { legacyAdapter } from './legacyAdapter.ts'
import { toV2Space } from './v2.fixture.ts'
import { V2_FILE_KEYS, V2_FILE_NAMES, validateV2Files, type V2FileKey, type V2SchemaProblem } from './v2Schema.ts'
import { serializeV2 } from './v2Serializer.ts'

type LooseFiles = Record<V2FileKey, Record<string, unknown> & { [key: string]: unknown }>

/** 合法的五个文件（JSON 值，可随意改）。 */
const validFiles = (raw = sampleRaw()): LooseFiles => {
  const { data } = toV2Space(legacyAdapter(raw))
  const files = serializeV2(data, {
    placesGeneratedAt: '2026-09-26T00:00:00.000Z',
    wantToGo: { generated_at: '2026-08-12T00:00:00.000Z', privacy_level: 'public-sample' },
    media: { generatedAt: '2026-09-01T00:00:00.000Z', privacyLevel: 'local-only' },
  })
  return JSON.parse(JSON.stringify(files)) as LooseFiles
}

// 为了在测试里随手改坏，统一按宽松的 JSON 结构取值。
type Obj = Record<string, unknown>
const obj = (value: unknown): Obj => value as Obj
const places = (files: LooseFiles): Obj[] => files.places.places as Obj[]
const records = (files: LooseFiles): Obj[] => files.travel.records as Obj[]
const itemsOf = (files: LooseFiles, key: 'wantToGo' | 'media'): Obj[] => files[key].items as Obj[]
const idOf = (place: Obj): string => place.id as string

const placeIndex = (files: LooseFiles, subtype: 'country' | 'city', nth = 0) =>
  places(files).map((place, index) => ({ place, index })).filter(({ place }) => place.subtype === subtype)[nth].index

const problemsAt = (problems: V2SchemaProblem[]) => problems.map((problem) => `${problem.file} ${problem.path}`)

const assertProblem = (files: LooseFiles, file: V2FileKey, path: string, code: V2SchemaProblem['code'] = 'INVALID') => {
  const problems = validateV2Files(files)
  assert.ok(
    problems.some((problem) => problem.file === file && problem.path === path && problem.code === code),
    `期望 ${file} ${path}（${code}），实际：\n${problemsAt(problems).join('\n')}`,
  )
}

test('合法样本：公开样例与个人模式 fixture 写成的五个文件都没有问题', () => {
  assert.deepEqual(validateV2Files(validFiles()), [])
  assert.deepEqual(validateV2Files(validFiles(consistentPersonalRaw())), [])
})

test('文件名：与旧文件同名，另加 places.local.json', () => {
  assert.deepEqual(V2_FILE_KEYS, ['places', 'travel', 'wantToGo', 'editorState', 'media'])
  assert.deepEqual(Object.values(V2_FILE_NAMES), [
    'places.local.json',
    'travel-map.local.json',
    'want-to-go.local.json',
    'editor-state.local.json',
    'user-media.local.json',
  ])
})

test('地点：id 必须是 UUIDv7 且唯一；国家必须有两位大写 ISO；城市必须属于国家', () => {
  const nonUuid = validFiles()
  places(nonUuid)[0].id = 'iceland'
  assertProblem(nonUuid, 'places', '$.places[0].id')

  const duplicate = validFiles()
  places(duplicate)[1].id = idOf(places(duplicate)[0])
  assertProblem(duplicate, 'places', '$.places[1].id')

  const noIso = validFiles()
  const country = placeIndex(noIso, 'country')
  delete places(noIso)[country].externalIds
  assertProblem(noIso, 'places', `$.places[${country}].externalIds.iso3166Alpha2`)

  const lowerIso = validFiles()
  obj(places(lowerIso)[country].externalIds).iso3166Alpha2 = 'is'
  assertProblem(lowerIso, 'places', `$.places[${country}].externalIds.iso3166Alpha2`)

  const orphan = validFiles()
  const city = placeIndex(orphan, 'city')
  delete places(orphan)[city].partOf
  assertProblem(orphan, 'places', `$.places[${city}].partOf`)

  const partOfCity = validFiles()
  places(partOfCity)[city].partOf = idOf(places(partOfCity)[placeIndex(partOfCity, 'city', 1)])
  assertProblem(partOfCity, 'places', `$.places[${city}].partOf`)

  const countryPartOf = validFiles()
  places(countryPartOf)[country].partOf = idOf(places(countryPartOf)[placeIndex(countryPartOf, 'country', 1)])
  assertProblem(countryPartOf, 'places', `$.places[${country}].partOf`)
})

test('地点：names 至少一项且都非空；location 在范围内；approximate 只能是 true；不认识的字段', () => {
  const emptyNames = validFiles()
  places(emptyNames)[0].names = {}
  assertProblem(emptyNames, 'places', '$.places[0].names')

  const blankName = validFiles()
  obj(places(blankName)[0].names).en = ''
  assertProblem(blankName, 'places', '$.places[0].names.en')

  const location = validFiles()
  const city = placeIndex(location, 'city')
  places(location)[city].location = { lat: 91, lng: 0, approximate: false }
  assertProblem(location, 'places', `$.places[${city}].location.lat`)
  assertProblem(location, 'places', `$.places[${city}].location.approximate`)

  const unknown = validFiles()
  places(unknown)[0].countryCode = 'is'
  assertProblem(unknown, 'places', '$.places[0].countryCode')
})

test('地点：legacyKeys 带与 subtype 相同的命名空间，且全文件唯一（重复单列为 DUPLICATE_LEGACY_KEY）', () => {
  const noPrefix = validFiles()
  places(noPrefix)[0].legacyKeys = ['iceland']
  assertProblem(noPrefix, 'places', '$.places[0].legacyKeys[0]')

  const wrongNamespace = validFiles()
  places(wrongNamespace)[0].legacyKeys = ['city:iceland']
  assertProblem(wrongNamespace, 'places', '$.places[0].legacyKeys[0]')

  const duplicate = validFiles()
  const second = placeIndex(duplicate, 'country', 1)
  places(duplicate)[second].legacyKeys = [...(places(duplicate)[0].legacyKeys as string[])]
  assertProblem(duplicate, 'places', `$.places[${second}].legacyKeys[0]`, 'DUPLICATE_LEGACY_KEY')
  assert.equal(validateV2Files(duplicate).filter((problem) => problem.code === 'DUPLICATE_LEGACY_KEY').length, 1)
})

test('足迹：版本、记录引用城市、坐标类型、不再有名称字段、显示规则引用、不认识的顶层字段', () => {
  const version = validFiles()
  version.travel.schema_version = 1
  assertProblem(version, 'travel', '$.schema_version')

  const toCountry = validFiles()
  records(toCountry)[0].placeId = idOf(places(toCountry)[placeIndex(toCountry, 'country')])
  assertProblem(toCountry, 'travel', '$.records[0].placeId')

  const legacyField = validFiles()
  records(legacyField)[0].country_en = 'Iceland'
  assertProblem(legacyField, 'travel', '$.records[0].country_en')

  const badLat = validFiles()
  records(badLat)[0].lat = '64.1'
  assertProblem(badLat, 'travel', '$.records[0].lat')

  const display = validFiles()
  ;(display.travel.display as { homeHiddenCountryIds: string[] }).homeHiddenCountryIds = ['iceland']
  assertProblem(display, 'travel', '$.display.homeHiddenCountryIds[0]')

  const extra = validFiles()
  extra.travel.countryCodes = {}
  assertProblem(extra, 'travel', '$.countryCodes')

  // generated_at 可以缺（私人目录只缺足迹文件时没有时间可写）。
  const noGeneratedAt = validFiles()
  delete noGeneratedAt.travel.generated_at
  assert.deepEqual(validateV2Files(noGeneratedAt), [])
})

test('想去：版本、addedAt 格式、hidden 布尔、placeId 引用存在的地点、不认识的字段', () => {
  const version = validFiles()
  version.wantToGo.schema_version = 1
  assertProblem(version, 'wantToGo', '$.schema_version')

  const item = validFiles()
  itemsOf(item, 'wantToGo')[0].addedAt = '2026/08/12'
  delete itemsOf(item, 'wantToGo')[0].hidden
  itemsOf(item, 'wantToGo')[0].placeId = 'wtg:gone'
  itemsOf(item, 'wantToGo')[0].place = {}
  assertProblem(item, 'wantToGo', '$.items[0].addedAt')
  assertProblem(item, 'wantToGo', '$.items[0].hidden')
  assertProblem(item, 'wantToGo', '$.items[0].placeId')
  assertProblem(item, 'wantToGo', '$.items[0].place')
})

test('编辑状态：版本、addedCountries 不再有 countryCode / center、引用必须存在', () => {
  const files = validFiles()
  const countryId = idOf(places(files)[placeIndex(files, 'country')])
  const cityId = idOf(places(files)[placeIndex(files, 'city')])
  files.editorState.schemaVersion = 1
  files.editorState.addedCountries = [{ placeId: countryId, countryCode: 'is', center: { lat: 1, lng: 2 } }, { placeId: cityId }]
  files.editorState.countryOrder = ['iceland']
  files.editorState.cityOrderByCountry = { [countryId]: ['iceland__vik'], missing: [] }
  files.editorState.coverMediaByCity = { [cityId]: 42 }
  assertProblem(files, 'editorState', '$.schemaVersion')
  assertProblem(files, 'editorState', '$.addedCountries[0].countryCode')
  assertProblem(files, 'editorState', '$.addedCountries[0].center')
  assertProblem(files, 'editorState', '$.addedCountries[1].placeId')
  assertProblem(files, 'editorState', '$.countryOrder[0]')
  assertProblem(files, 'editorState', `$.cityOrderByCountry["${countryId}"][0]`)
  assertProblem(files, 'editorState', '$.cityOrderByCountry.missing(键)')
  assertProblem(files, 'editorState', `$.coverMediaByCity["${cityId}"]`)
})

test('媒体：版本 3、kind、placeId 指向城市、不再有 cityId / titleZh 等旧字段、title 的形状', () => {
  const files = validFiles(consistentPersonalRaw())
  assert.ok(itemsOf(files, 'media').length >= 2)
  files.media.schemaVersion = 2
  const [first, second] = itemsOf(files, 'media')
  first.kind = 'gif'
  first.cityId = 'iceland__reykjavik'
  first.titleZh = '港口'
  second.placeId = idOf(places(files)[placeIndex(files, 'country')])
  second.title = { names: {} }
  assertProblem(files, 'media', '$.schemaVersion')
  assertProblem(files, 'media', '$.items[0].kind')
  assertProblem(files, 'media', '$.items[0].cityId')
  assertProblem(files, 'media', '$.items[0].titleZh')
  assertProblem(files, 'media', '$.items[1].placeId')
  assertProblem(files, 'media', '$.items[1].title.names')

  // 旧文件的其他顶层字段允许保留。
  assert.deepEqual(validateV2Files(validFiles(consistentPersonalRaw())), [])
})

test('整份文件不是对象、缺数组：每个文件各报一处，不抛异常', () => {
  const problems = validateV2Files({ places: null, travel: [], wantToGo: 'x', editorState: 1, media: undefined })
  assert.deepEqual(problems.map((problem) => `${problem.file} ${problem.path}`), [
    'places $',
    'travel $',
    'wantToGo $',
    'editorState $',
    'media $',
  ])
  const noArrays = validateV2Files({
    places: { schema_version: 1, generated_at: 'x' },
    travel: { schema_version: 2, display: {} },
    wantToGo: { schema_version: 2 },
    editorState: { schemaVersion: 2 },
    media: { schemaVersion: 3 },
  })
  for (const where of ['places $.places', 'travel $.records', 'wantToGo $.items', 'editorState $.addedCountries', 'media $.items']) {
    assert.ok(problemsAt(noArrays).includes(where), where)
  }
})
