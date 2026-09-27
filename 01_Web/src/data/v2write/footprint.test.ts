/**
 * 足迹与国家的 V2 写入（v2write/footprint.ts）的单元测试（RFC-LOC-1 PR3b-2 规格 §2.3、§2.4、§2.6、§3）：
 * `POST /records`、`POST /countries`、`POST /countries/delete`。
 *
 * 运行方式：npm test。零依赖：Node 24 自带类型剥离，只用 node:test + node:assert/strict。
 * 数据是中性个人模式数据迁移后的 V2 文件（./v2write.fixture.ts）。
 */

/// <reference types="node" />

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { isUuidV7 } from '../canonical/uuidv7.ts'
import type { V2Files, V2TravelRecord } from '../canonical/v2Schema.ts'
import { addCountry, addTravelRecord, deleteHiddenCountries } from './footprint.ts'
import {
  GHOST_ID,
  WRITE_NOW,
  applyWrites,
  assertIntact,
  assertV2Error,
  migratedFiles,
  placeNamed,
  testContext,
  writeOrder,
} from './v2write.fixture.ts'

const HOFN = { lat: 64.2539, lng: -15.2082 }

/** 在冰岛新增赫本（一个全新的城市）的请求体。 */
const hofnInput = (overrides: Record<string, unknown> = {}) => ({
  country: '冰岛',
  country_en: 'Iceland',
  country_code: 'is',
  city: '赫本',
  city_en: 'Hofn',
  start_date: '2026-07-01',
  end_date: '2026-07-02',
  ...HOFN,
  ...overrides,
})

const lastRecord = (files: V2Files) => files.travel.records.at(-1) as V2TravelRecord

// ---------------------------------------------------------------------------
// POST /records
// ---------------------------------------------------------------------------

test('新增足迹：新城市——先写地点、再写足迹；记录只引用地点；坐标与城市相同时省略；默认行程标题与新 journeyId', () => {
  const files = migratedFiles()
  const outcome = addTravelRecord(files, hofnInput(), testContext())
  assert.deepEqual(writeOrder(outcome.writes), ['places', 'travel'], '冰岛已在足迹中，不重排')
  const next = applyWrites(files, outcome.writes)
  assertIntact(next)

  const iceland = placeNamed(files, 'Iceland').id
  const hofn = placeNamed(next, 'Hofn')
  assert.ok(isUuidV7(hofn.id))
  assert.deepEqual(hofn, { id: hofn.id, subtype: 'city', names: { 'zh-Hans': '赫本', en: 'Hofn' }, partOf: iceland, location: HOFN })
  assert.equal(Object.hasOwn(hofn, 'legacyKeys'), false)

  const record = lastRecord(next)
  assert.ok(isUuidV7(record.id))
  assert.ok(typeof record.journeyId === 'string' && /^journey-[0-9a-f-]{36}$/.test(record.journeyId) && isUuidV7(record.journeyId.slice(8)))
  assert.deepEqual(record, {
    id: record.id,
    placeId: hofn.id,
    start_date: '2026-07-01',
    end_date: '2026-07-02',
    year: 2026,
    trip_title: '冰岛 · 赫本',
    type: 'visit',
    status: 'visited',
    source: 'local-editor',
    journeyId: record.journeyId,
  })
  assert.deepEqual(outcome.result, { id: record.id, countryId: iceland, cityId: hofn.id })
  assert.equal(next.travel.generated_at, WRITE_NOW.toISOString())
  assert.equal(next.places.places.length, files.places.places.length + 1)
})

test('新增足迹：行程标题与已去过的记录完全相同 → 沿用那条的 journeyId；坐标与城市不同时写进记录', () => {
  const files = migratedFiles()
  const outcome = addTravelRecord(files, hofnInput({ trip_title: ' 2025 North Atlantic Demo ' }), testContext())
  const record = lastRecord(applyWrites(files, outcome.writes))
  assert.equal(record.journeyId, '2025-north-atlantic-demo')
  assert.equal(record.trip_title, '2025 North Atlantic Demo')

  // 解析到已有城市（只被想去引用的努克），坐标与城市不同：记录保留自己的坐标，城市坐标不改。
  const nuukFiles = migratedFiles()
  const nuuk = placeNamed(nuukFiles, 'Nuuk')
  const moved = addTravelRecord(nuukFiles, { ...hofnInput(), country: '格陵兰', country_en: 'Greenland', country_code: 'GL', city: '努克', city_en: 'Nuuk', lat: 64.2, lng: -51.7 }, testContext())
  const after = applyWrites(nuukFiles, moved.writes)
  assert.deepEqual(placeNamed(after, 'Nuuk').location, nuuk.location)
  assert.equal(lastRecord(after).lat, 64.2)
  assert.equal(lastRecord(after).lng, -51.7)
})

test('新增足迹复用「只被想去引用的城市」：不新建地点；国家首次进入足迹 → 重排 countryOrder（足迹 → editor-state）', () => {
  const files = migratedFiles()
  const nuuk = placeNamed(files, 'Nuuk')
  const greenland = placeNamed(files, 'Greenland').id
  const outcome = addTravelRecord(files, {
    ...hofnInput(), country: '格陵兰', country_en: 'Greenland', country_code: 'GL', city: '努克', city_en: 'nuuk',
    start_date: '2026-08-01', end_date: undefined, lat: nuuk.location!.lat, lng: nuuk.location!.lng,
  }, testContext())
  assert.deepEqual(writeOrder(outcome.writes), ['travel', 'editorState'])
  assert.equal(outcome.writes[1].onFailure, '足迹已创建，但国家列表的排序没有更新（{reason}）。')
  const next = applyWrites(files, outcome.writes)
  assertIntact(next)
  assert.equal(next.places.places.length, files.places.places.length)
  const record = lastRecord(next)
  assert.equal(record.placeId, nuuk.id)
  assert.equal(Object.hasOwn(record, 'lat'), false)
  assert.equal(record.trip_title, '格陵兰 · 努克', '名称以地点为准')
  assert.equal(Object.hasOwn(record, 'end_date'), false)
  // 格陵兰（2026-08-01）最近，排在最前；冰岛与法罗群岛都是 2025-06，保持原来的先后。
  assert.deepEqual(next.editorState.countryOrder, [greenland, ...files.editorState.countryOrder])
  assert.deepEqual(outcome.result, { id: record.id, countryId: greenland, cityId: nuuk.id })
})

test('新增足迹：复用的城市没有坐标时，把输入的坐标补到地点上（先写地点）', () => {
  const files = migratedFiles()
  const nuuk = placeNamed(files, 'Nuuk')
  delete nuuk.location
  const outcome = addTravelRecord(files, { ...hofnInput(), country_code: 'GL', city: '努克', city_en: 'Nuuk', lat: 64.18, lng: -51.69 }, testContext())
  assert.deepEqual(writeOrder(outcome.writes), ['places', 'travel', 'editorState'])
  const next = applyWrites(files, outcome.writes)
  assert.deepEqual(placeNamed(next, 'Nuuk').location, { lat: 64.18, lng: -51.69 })
  assert.equal(Object.hasOwn(lastRecord(next), 'lat'), false, '坐标已与城市相同')
})

test('新增足迹：任何记录（含 planned）已引用该城市 → E_CITY_EXISTS（沿用旧文案），不写', () => {
  const files = migratedFiles()
  const message = '这个城市已经存在；如需增加一次新的行程，请使用行程编辑，而不是重复添加城市。'
  assertV2Error(() => addTravelRecord(files, hofnInput({ city: '雷克雅未克', city_en: 'REYKJAVIK' }), testContext()), 'E_CITY_EXISTS', message)
  assertV2Error(() => addTravelRecord(files, hofnInput({ country_code: 'no', city: '卑尔根', city_en: 'Bergen' }), testContext()), 'E_CITY_EXISTS', message)
})

test('新增足迹：输入校验与旧模式相同的文案；V2 下国家代码必填', () => {
  const files = migratedFiles()
  const cases: [Record<string, unknown>, string, string][] = [
    [{ country: ' ' }, 'E_REQUIRED', '请填写国家中文名。'],
    [{ country_en: undefined }, 'E_REQUIRED', '请填写国家英文名。'],
    [{ city: '' }, 'E_REQUIRED', '请填写城市中文名。'],
    [{ city_en: 3 }, 'E_REQUIRED', '请填写城市英文名。'],
    [{ start_date: '' }, 'E_REQUIRED', '请填写到访日期。'],
    [{ start_date: '2026/07/01' }, 'E_DATE_FORMAT', '到访日期必须使用 YYYY-MM-DD。'],
    [{ end_date: '07-02' }, 'E_DATE_FORMAT', '结束日期必须使用 YYYY-MM-DD。'],
    [{ end_date: '2026-06-30' }, 'E_DATE_ORDER', '结束日期不能早于到访日期。'],
    [{ lat: null }, 'E_REQUIRED', '请填写纬度。'],
    [{ lat: 91 }, 'E_NUMBER_INVALID', '纬度无效。'],
    [{ lng: 'east' }, 'E_NUMBER_INVALID', '经度无效。'],
    [{ country_code: undefined }, 'E_COUNTRY_CODE_REQUIRED', '请填写国家代码。'],
    [{ country_code: ' ' }, 'E_COUNTRY_CODE_REQUIRED', '请填写国家代码。'],
    [{ country_code: 'isl' }, 'E_COUNTRY_CODE_INVALID', '国家代码必须是两个英文字母。'],
    [{ country_code: 'ZZ' }, 'E_COUNTRY_NOT_IN_CATALOG', '没有找到这个国家，请从候选列表中选择。'],
  ]
  for (const [overrides, code, message] of cases) {
    assertV2Error(() => addTravelRecord(files, hofnInput(overrides), testContext()), code as never, message)
  }
  assertV2Error(() => addTravelRecord(files, null, testContext()), 'E_REQUIRED', '请填写国家中文名。')
})

test('新增足迹：候选地点不唯一 → E_PLACE_AMBIGUOUS（不猜），不写', () => {
  const files = migratedFiles()
  const iceland = placeNamed(files, 'Iceland').id
  files.places.places.push({ id: '019b76da-a8f0-7000-8000-0000000000f0', subtype: 'city', names: { 'zh-Hans': '赫本港', en: 'hofn' }, partOf: iceland })
  files.places.places.push({ id: '019b76da-a8f1-7000-8000-0000000000f1', subtype: 'city', names: { en: 'Hofn!' }, partOf: iceland })
  assertV2Error(() => addTravelRecord(files, hofnInput(), testContext()), 'E_PLACE_AMBIGUOUS', undefined, (error) => {
    assert.equal(error.params?.subtype, 'city')
    assert.deepEqual(error.params?.candidates, ['019b76da-a8f0-7000-8000-0000000000f0', '019b76da-a8f1-7000-8000-0000000000f1'])
  })
  const twoIcelands = migratedFiles()
  twoIcelands.places.places.push({ id: '019b76da-a8f2-7000-8000-0000000000f2', subtype: 'country', names: { en: 'Iceland 2' }, externalIds: { iso3166Alpha2: 'IS' } })
  assertV2Error(() => addTravelRecord(twoIcelands, hofnInput(), testContext()), 'E_PLACE_AMBIGUOUS', undefined, (error) => assert.equal(error.params?.subtype, 'country'))
})

test('新增足迹 · 全新 V2 目录：按目录新建国家，新建城市，重排；三个文件都写，合法；没有任何样例数据', () => {
  const outcome = addTravelRecord(undefined, {
    country: '日本', country_en: 'Japan', country_code: 'jp', city: '东京', city_en: 'Tokyo', start_date: '2024-04-01', lat: 35.68, lng: 139.69,
  }, testContext())
  assert.deepEqual(writeOrder(outcome.writes), ['places', 'travel', 'editorState'])
  const next = applyWrites({}, outcome.writes)
  assertIntact(next)
  assert.equal(next.places.places.length, 2)
  const japan = placeNamed(next, 'Japan')
  assert.deepEqual(japan, { id: japan.id, subtype: 'country', names: { 'zh-Hans': '日本', en: 'Japan' }, externalIds: { iso3166Alpha2: 'JP' }, location: { lat: 36, lng: 138 } })
  assert.equal(next.travel.records.length, 1)
  assert.equal(next.travel.privacy_level, 'private-local')
  assert.deepEqual(next.editorState.countryOrder, [japan.id])
  assert.ok(!JSON.stringify(next).includes('sample'), '没有复制样例')
})

test('新增足迹 · 完整性：现有文件里有悬空引用 → E_INTEGRITY（入口）；产出的地点 id 不合法 → E_INTEGRITY（出口）；都不给出写入', () => {
  const broken = migratedFiles()
  broken.editorState.hiddenCityIds.push(GHOST_ID)
  assertV2Error(() => addTravelRecord(broken, hofnInput(), testContext()), 'E_INTEGRITY', undefined, (error) => assert.equal(error.params?.stage, 'input'))
  assertV2Error(() => addTravelRecord(migratedFiles(), hofnInput(), testContext({ newId: () => 'not-a-uuid' })), 'E_INTEGRITY', undefined, (error) => assert.equal(error.params?.stage, 'output'))
})

// ---------------------------------------------------------------------------
// POST /countries
// ---------------------------------------------------------------------------

test('新增国家：按目录新建国家地点；追加 addedCountries（placeId、region、visitedDate）并按最近到访日期重排（地点 → editor-state）', () => {
  const files = migratedFiles()
  const outcome = addCountry(files, { countryCode: 'jp', visitedDate: '2026-05-01' }, testContext())
  assert.deepEqual(writeOrder(outcome.writes), ['places', 'editorState'])
  const next = applyWrites(files, outcome.writes)
  assertIntact(next)
  const japan = placeNamed(next, 'Japan').id
  assert.deepEqual(outcome.result, { countryId: japan })
  assert.deepEqual(next.editorState.addedCountries, [{ placeId: japan, region: 'Asia', visitedDate: '2026-05-01' }])
  assert.deepEqual(next.editorState.countryOrder, [japan, ...files.editorState.countryOrder])

  // 更早的日期排到后面。
  const older = applyWrites(files, addCountry(files, { countryCode: 'JP', visitedDate: '2020-01-01' }, testContext()).writes)
  assert.deepEqual(older.editorState.countryOrder, [...files.editorState.countryOrder, placeNamed(older, 'Japan').id])
})

test('新增国家：国家地点已存在（只被想去或 planned 引用）就复用，只写 editor-state', () => {
  for (const name of ['Greenland', 'Norway']) {
    const files = migratedFiles()
    const outcome = addCountry(files, { countryCode: name === 'Greenland' ? 'GL' : 'NO', visitedDate: '2023-01-01' }, testContext())
    assert.deepEqual(writeOrder(outcome.writes), ['editorState'], name)
    const next = applyWrites(files, outcome.writes)
    assertIntact(next)
    assert.equal(next.places.places.length, files.places.places.length)
    assert.deepEqual(next.editorState.addedCountries.map((entry) => entry.placeId), [placeNamed(files, name).id])
  }
})

test('新增国家：已在足迹中（有已去过的记录，或已有 addedCountries 条目）→ E_COUNTRY_EXISTS（沿用旧文案）', () => {
  const files = migratedFiles()
  assertV2Error(() => addCountry(files, { countryCode: 'IS', visitedDate: '2026-01-01' }, testContext()), 'E_COUNTRY_EXISTS', '这个国家已经存在于国家足迹中。')
  const withJapan = applyWrites(files, addCountry(files, { countryCode: 'JP', visitedDate: '2026-01-01' }, testContext()).writes)
  assertV2Error(() => addCountry(withJapan, { countryCode: 'jp', visitedDate: '2026-02-01' }, testContext()), 'E_COUNTRY_EXISTS')
})

test('新增国家：输入校验与旧模式相同的文案；目录里没有 → E_COUNTRY_NOT_IN_CATALOG', () => {
  const files = migratedFiles()
  assertV2Error(() => addCountry(files, { visitedDate: '2026-01-01' }, testContext()), 'E_REQUIRED', '请填写国家代码。')
  assertV2Error(() => addCountry(files, { countryCode: 'JP' }, testContext()), 'E_REQUIRED', '请填写首次到访日期。')
  assertV2Error(() => addCountry(files, { countryCode: 'JP', visitedDate: '2026-1-1' }, testContext()), 'E_DATE_FORMAT', '首次到访日期必须使用 YYYY-MM-DD。')
  assertV2Error(() => addCountry(files, { countryCode: 'ZZ', visitedDate: '2026-01-01' }, testContext()), 'E_COUNTRY_NOT_IN_CATALOG', '没有找到这个国家，请从候选列表中选择。')
  assertV2Error(() => addCountry(files, { countryCode: 'JPN', visitedDate: '2026-01-01' }, testContext()), 'E_COUNTRY_NOT_IN_CATALOG')
})

test('新增国家 · 全新 V2 目录：写地点与 editor-state，合法；完整性不通过时 E_INTEGRITY', () => {
  const outcome = addCountry({}, { countryCode: 'JP', visitedDate: '2026-01-01' }, testContext())
  assert.deepEqual(writeOrder(outcome.writes), ['places', 'editorState'])
  const next = applyWrites({}, outcome.writes)
  assertIntact(next)
  assert.equal(next.places.places.length, 1)

  const broken = migratedFiles()
  broken.wantToGo.items[0].placeId = GHOST_ID
  assertV2Error(() => addCountry(broken, { countryCode: 'JP', visitedDate: '2026-01-01' }, testContext()), 'E_INTEGRITY')
  assertV2Error(() => addCountry(migratedFiles(), { countryCode: 'JP', visitedDate: '2026-01-01' }, testContext({ newId: () => 'x' })), 'E_INTEGRITY', undefined, (error) => assert.equal(error.params?.stage, 'output'))
})

// ---------------------------------------------------------------------------
// POST /countries/delete
// ---------------------------------------------------------------------------

/** 隐藏若干国家（客户端在彻底删除前也会先把它们写进 hiddenCountryIds）。 */
const hide = (files: V2Files, ...ids: string[]) => {
  files.editorState.hiddenCountryIds = [...new Set([...files.editorState.hiddenCountryIds, ...ids])]
  return files
}

test('删除国家后地点清理：删掉该国全部记录与 editor-state 里的键与值；被想去引用的城市（与它的国家）保留（editor-state → 足迹 → 地点）', () => {
  const files = migratedFiles()
  const iceland = placeNamed(files, 'Iceland').id
  const reykjavik = placeNamed(files, 'Reykjavik').id
  const vik = placeNamed(files, 'Vik').id
  const akureyri = placeNamed(files, 'Akureyri').id
  files.media.items = files.media.items.filter((item) => item.placeId !== reykjavik)
  files.editorState.cityOrderByCountry = { [iceland]: [akureyri, reykjavik] }
  files.editorState.mediaOrderByCity = { [reykjavik]: ['gone'] }
  hide(files, iceland)

  const outcome = deleteHiddenCountries(files, { ids: [` ${iceland} `, iceland] }, testContext())
  assert.deepEqual(writeOrder(outcome.writes), ['editorState', 'travel', 'places'])
  assert.equal(outcome.writes[1].onFailure, '国家的编辑状态已清除，但足迹记录没有删除（{reason}）。这个国家会重新显示，可以再次隐藏后彻底删除。')
  assert.equal(outcome.writes[2].onFailure, '国家已删除，但地点注册表没有清理（{reason}）。这不影响显示。')
  assert.deepEqual(outcome.result, { deletedCountryIds: [iceland], deletedRecordCount: 3 })
  const next = applyWrites(files, outcome.writes)
  assertIntact(next)

  assert.equal(next.travel.records.some((record) => [reykjavik, vik, akureyri].includes(record.placeId)), false)
  const ids = new Set(next.places.places.map((place) => place.id))
  assert.equal(ids.has(reykjavik), false)
  assert.equal(ids.has(vik), false)
  assert.equal(ids.has(akureyri), true, '阿克雷里仍被想去条目引用')
  assert.equal(ids.has(iceland), true, '冰岛仍被阿克雷里的 partOf 引用')
  assert.deepEqual(next.editorState.countryOrder, [placeNamed(files, 'Faroe Islands').id])
  assert.deepEqual(next.editorState.hiddenCountryIds, [])
  assert.deepEqual(next.editorState.hiddenCityIds, [])
  assert.deepEqual(next.editorState.cityOrderByCountry, {})
  assert.deepEqual(next.editorState.coverMediaByCity, {})
  assert.deepEqual(next.editorState.mediaOrderByCity, {})
})

test('删除国家：只有 planned 记录的国家——记录删掉，只被它引用的城市删掉；被想去引用的特罗姆瑟与挪威保留', () => {
  const files = hide(migratedFiles(), placeNamed(migratedFiles(), 'Norway').id)
  const norway = placeNamed(files, 'Norway').id
  const outcome = deleteHiddenCountries(files, { ids: [norway] }, testContext())
  assert.deepEqual(outcome.result, { deletedCountryIds: [norway], deletedRecordCount: 1 })
  const next = applyWrites(files, outcome.writes)
  assertIntact(next)
  const ids = new Set(next.places.places.map((place) => place.id))
  assert.equal(ids.has(placeNamed(files, 'Bergen').id), false)
  assert.equal(ids.has(placeNamed(files, 'Tromsø').id), true)
  assert.equal(ids.has(norway), true)
})

test('删除国家：只在 addedCountries 里的国家——条目删掉，国家地点删掉（editor-state → 地点）；被显示规则引用的地点保留', () => {
  const files = migratedFiles()
  const added = applyWrites(files, addCountry(files, { countryCode: 'JP', visitedDate: '2026-01-01' }, testContext()).writes)
  const japan = placeNamed(added, 'Japan').id
  hide(added, japan)
  const outcome = deleteHiddenCountries(added, { ids: [japan] }, testContext())
  assert.deepEqual(writeOrder(outcome.writes), ['editorState', 'places'])
  assert.deepEqual(outcome.result, { deletedCountryIds: [japan], deletedRecordCount: 0 })
  const next = applyWrites(added, outcome.writes)
  assertIntact(next)
  assert.deepEqual(next.editorState.addedCountries, [])
  assert.equal(next.places.places.some((place) => place.id === japan), false)
  assert.deepEqual(next.places.places, files.places.places)

  // 显示规则（例如「不上首页」）仍引用它：地点保留，规则不动。
  added.travel.display.homeHiddenCountryIds = [japan]
  const kept = deleteHiddenCountries(added, { ids: [japan] }, testContext())
  assert.deepEqual(writeOrder(kept.writes), ['editorState'])
  assertIntact(applyWrites(added, kept.writes))
})

test('删除国家：前置条件与旧模式相同的文案', () => {
  const files = migratedFiles()
  const iceland = placeNamed(files, 'Iceland').id
  const faroe = placeNamed(files, 'Faroe Islands').id
  assertV2Error(() => deleteHiddenCountries(files, {}, testContext()), 'E_COUNTRY_DELETE_EMPTY', '没有可删除的隐藏国家。')
  assertV2Error(() => deleteHiddenCountries(files, { ids: [' '] }, testContext()), 'E_COUNTRY_DELETE_EMPTY')
  assertV2Error(() => deleteHiddenCountries(files, { ids: [iceland] }, testContext()), 'E_COUNTRY_DELETE_NOT_HIDDEN', '只能彻底删除已经隐藏的国家。')
  const greenland = placeNamed(files, 'Greenland').id
  assertV2Error(() => deleteHiddenCountries(hide(migratedFiles(), greenland), { ids: [greenland] }, testContext()), 'E_COUNTRY_DELETE_NO_DATA', '找不到待删除国家的本地旅行数据，已停止删除。')
  // 该国家还有媒体（托尔斯港一张航拍；雷克雅未克两张照片）。
  assertV2Error(() => deleteHiddenCountries(hide(migratedFiles(), faroe), { ids: [faroe] }, testContext()), 'E_COUNTRY_HAS_MEDIA',
    '以下城市仍有照片或无人机影像：托尔斯港（1 个媒体）。请先在对应城市中彻底删除这些媒体。')
  assertV2Error(() => deleteHiddenCountries(hide(migratedFiles(), iceland, faroe), { ids: [iceland, faroe] }, testContext()), 'E_COUNTRY_HAS_MEDIA',
    '以下城市仍有照片或无人机影像：雷克雅未克（2 个媒体）、托尔斯港（1 个媒体）。请先在对应城市中彻底删除这些媒体。')
})

test('删除国家 · 全新 V2 目录与完整性：空目录里没有隐藏国家；入口有悬空引用 → E_INTEGRITY', () => {
  assertV2Error(() => deleteHiddenCountries(undefined, { ids: [GHOST_ID] }, testContext()), 'E_COUNTRY_DELETE_NOT_HIDDEN')
  const broken = migratedFiles()
  broken.media.items[0].placeId = GHOST_ID
  assertV2Error(() => deleteHiddenCountries(broken, { ids: [placeNamed(broken, 'Norway').id] }, testContext()), 'E_INTEGRITY')
})
