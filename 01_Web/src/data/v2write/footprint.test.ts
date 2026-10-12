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
import { deriveAppDataFromCanonical } from '../canonical/derive.ts'
import { readV2 } from '../canonical/v2Reader.ts'
import type { V2Files, V2TravelRecord } from '../canonical/v2Schema.ts'
import { addCountry, addTravelRecord, deleteHiddenCountries } from './footprint.ts'
import { addWantToGo } from './wantToGo.ts'
import {
  GHOST_ID,
  SUZHOU_AH,
  SUZHOU_JS,
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

test('新增足迹：行程标题与已去过的记录完全相同 → 沿用那条的 journeyId；按地点 id 引用时记录坐标就是地点坐标', () => {
  const files = migratedFiles()
  const outcome = addTravelRecord(files, hofnInput({ trip_title: ' 2025 North Atlantic Demo ' }), testContext())
  const record = lastRecord(applyWrites(files, outcome.writes))
  assert.equal(record.journeyId, '2025-north-atlantic-demo')
  assert.equal(record.trip_title, '2025 North Atlantic Demo')

  // 改写（第 2A 批）：旧用例按名字解析到努克、记录保留与城市不同的输入坐标（「身份是努克，坐标是别处」）。
  // 新规则：按名字不再复用；用户选定努克（地点 id）时，记录坐标就是地点坐标，输入的坐标不覆盖，城市坐标不改。
  const nuukFiles = migratedFiles()
  const nuuk = placeNamed(nuukFiles, 'Nuuk')
  const moved = addTravelRecord(nuukFiles, { placeId: nuuk.id, start_date: '2026-07-01', lat: 64.2, lng: -51.7 }, testContext())
  const after = applyWrites(nuukFiles, moved.writes)
  assertIntact(after)
  assert.deepEqual(placeNamed(after, 'Nuuk').location, nuuk.location)
  assert.equal(lastRecord(after).placeId, nuuk.id)
  assert.equal(Object.hasOwn(lastRecord(after), 'lat'), false)
  assert.equal(Object.hasOwn(lastRecord(after), 'lng'), false)
})

test('新增足迹按地点 id 引用「只被想去引用的城市」：不新建地点；国家首次进入足迹 → 重排 countryOrder（足迹 → editor-state）', () => {
  // 改写（第 2A 批）：旧用例按名字（city_en: 'nuuk'）静默复用努克；现在按名字只得到「请选择」，用户选定后按地点 id 引用。
  const files = migratedFiles()
  const nuuk = placeNamed(files, 'Nuuk')
  const greenland = placeNamed(files, 'Greenland').id
  assertV2Error(() => addTravelRecord(files, {
    ...hofnInput(), country: '格陵兰', country_en: 'Greenland', country_code: 'GL', city: '努克', city_en: 'nuuk',
    start_date: '2026-08-01', end_date: undefined, lat: nuuk.location!.lat, lng: nuuk.location!.lng,
  }, testContext()), 'E_PLACE_CHOICE_REQUIRED', undefined, (error) => {
    assert.deepEqual((error.params?.candidates as { placeId: string; strong: boolean }[]).map(({ placeId, strong }) => ({ placeId, strong })), [{ placeId: nuuk.id, strong: true }])
  })
  const outcome = addTravelRecord(files, { placeId: ` ${nuuk.id} `, start_date: '2026-08-01' }, testContext())
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

test('新增足迹按地点 id 引用：城市没有坐标时，把输入的坐标补到地点上（先写地点）；两者都没有 → E_REQUIRED', () => {
  // 改写（第 2A 批）：旧用例按名字复用没有坐标的努克；现在是用户按地点 id 选定它。
  const files = migratedFiles()
  const nuuk = placeNamed(files, 'Nuuk')
  delete nuuk.location
  const outcome = addTravelRecord(files, { placeId: nuuk.id, start_date: '2026-07-01', lat: 64.18, lng: -51.69 }, testContext())
  assert.deepEqual(writeOrder(outcome.writes), ['places', 'travel', 'editorState'])
  const next = applyWrites(files, outcome.writes)
  assertIntact(next)
  assert.deepEqual(placeNamed(next, 'Nuuk').location, { lat: 64.18, lng: -51.69 })
  assert.equal(Object.hasOwn(lastRecord(next), 'lat'), false, '坐标已与城市相同')
  assertV2Error(() => addTravelRecord(files, { placeId: nuuk.id, start_date: '2026-07-01' }, testContext()), 'E_REQUIRED', '请填写纬度。')
})

test('新增足迹：按地点 id 引用、而任何记录（含 planned）已引用该城市 → E_CITY_EXISTS（沿用旧文案），不写', () => {
  // 改写（第 2A 批）：旧用例按名字（REYKJAVIK、Bergen）解析到已有城市；按名字现在只会要求选择，E_CITY_EXISTS 只在明确的 placeId 上出现。
  const files = migratedFiles()
  const before = structuredClone(files)
  const message = '这个城市已经存在；如需增加一次新的行程，请使用行程编辑，而不是重复添加城市。'
  for (const name of ['Reykjavik', 'Bergen']) {
    const cityId = placeNamed(files, name).id
    assertV2Error(() => addTravelRecord(files, { placeId: cityId, start_date: '2026-07-01' }, testContext()), 'E_CITY_EXISTS', message, (error) => {
      assert.deepEqual(error.params, { cityId })
    })
  }
  assertV2Error(() => addTravelRecord(files, hofnInput({ city: '雷克雅未克', city_en: 'REYKJAVIK' }), testContext()), 'E_PLACE_CHOICE_REQUIRED')
  assert.deepEqual(files, before)
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

test('新增足迹：多个同名候选 → E_PLACE_CHOICE_REQUIRED 列出全部候选（不猜），不写；国家不唯一仍是 E_PLACE_AMBIGUOUS', () => {
  // 改写（第 2A 批）：旧用例两个同名城市报 E_PLACE_AMBIGUOUS（文案还引导「先合并」）；现在列出候选请用户选择。
  const files = migratedFiles()
  const iceland = placeNamed(files, 'Iceland').id
  files.places.places.push({ id: '019b76da-a8f0-7000-8000-0000000000f0', subtype: 'city', names: { 'zh-Hans': '赫本港', en: 'hofn' }, partOf: iceland })
  files.places.places.push({ id: '019b76da-a8f1-7000-8000-0000000000f1', subtype: 'city', names: { en: 'Hofn!' }, partOf: iceland })
  const before = structuredClone(files)
  assertV2Error(() => addTravelRecord(files, hofnInput(), testContext()), 'E_PLACE_CHOICE_REQUIRED', '找到可能是同一个地方的已有地点，请选择要使用的地点，或新建一个独立地点。本次尚未保存。', (error) => {
    assert.equal(error.params?.subtype, 'city')
    assert.equal(error.params?.countryId, iceland)
    assert.deepEqual(error.params?.candidates, [
      { placeId: '019b76da-a8f0-7000-8000-0000000000f0', names: { 'zh-Hans': '赫本港', en: 'hofn' }, strong: false },
      { placeId: '019b76da-a8f1-7000-8000-0000000000f1', names: { en: 'Hofn!' }, strong: false },
    ])
  })
  assert.deepEqual(files, before, '不写')
  const twoIcelands = migratedFiles()
  twoIcelands.places.places.push({ id: '019b76da-a8f2-7000-8000-0000000000f2', subtype: 'country', names: { en: 'Iceland 2' }, externalIds: { iso3166Alpha2: 'IS' } })
  assertV2Error(() => addTravelRecord(twoIcelands, hofnInput(), testContext()), 'E_PLACE_AMBIGUOUS', '找到多个可能的地点，请选择要使用的地点，或新建一个独立地点。本次尚未保存。', (error) => assert.equal(error.params?.subtype, 'country'))
})

// ---------------------------------------------------------------------------
// 同名不同城（第 2A 批）：苏州 / 宿州，英文名都是 Suzhou
// ---------------------------------------------------------------------------

const suzhouInput = (cityZh: string, at: { lat: number; lng: number }, overrides: Record<string, unknown> = {}) => ({
  country: '中国', country_en: 'China', country_code: 'CN', city: cityZh, city_en: 'Suzhou', start_date: '2026-05-01', ...at, ...overrides,
})

type CandidateParam = { placeId: string; names: Record<string, string>; location?: { lat: number; lng: number }; distanceKm?: number; strong: boolean }
const candidatesOf = (error: { params?: Record<string, unknown> }) => error.params?.candidates as CandidateParam[]

test('同名不同城：已有苏州足迹，按名字提交宿州足迹 → E_PLACE_CHOICE_REQUIRED 与候选（不写）；createNew → 新建独立地点；苏州的 placeId → E_CITY_EXISTS', () => {
  const ctx = testContext()
  const base = migratedFiles()
  const files = applyWrites(base, addTravelRecord(base, suzhouInput('苏州', SUZHOU_JS), ctx).writes)
  const suzhou = placeNamed(files, 'Suzhou')
  const china = placeNamed(files, 'China')
  const before = structuredClone(files)

  assertV2Error(() => addTravelRecord(files, suzhouInput('宿州', SUZHOU_AH, { start_date: '2026-05-03' }), ctx), 'E_PLACE_CHOICE_REQUIRED', undefined, (error) => {
    assert.deepEqual(error.params?.subtype, 'city')
    assert.deepEqual(error.params?.countryId, china.id)
    const [candidate, ...rest] = candidatesOf(error)
    assert.equal(rest.length, 0)
    assert.equal(candidate.placeId, suzhou.id)
    assert.deepEqual(candidate.names, { 'zh-Hans': '苏州', en: 'Suzhou' })
    assert.deepEqual(candidate.location, SUZHOU_JS)
    assert.equal(candidate.strong, false, '中文名不同、相距约 400 km')
    assert.ok(candidate.distanceKm !== undefined && candidate.distanceKm > 350 && candidate.distanceKm < 500, String(candidate.distanceKm))
  })
  assert.deepEqual(files, before, '不写')

  const created = addTravelRecord(files, suzhouInput('宿州', SUZHOU_AH, { start_date: '2026-05-03', createNew: true }), ctx)
  assert.deepEqual(writeOrder(created.writes), ['places', 'travel'])
  const next = applyWrites(files, created.writes)
  assertIntact(next)
  const suzhous = next.places.places.filter((place) => place.names.en === 'Suzhou')
  assert.equal(suzhous.length, 2, '两个城市各自是一个地点')
  const suxian = suzhous.find((place) => place.names['zh-Hans'] === '宿州')!
  assert.deepEqual(suxian, { id: suxian.id, subtype: 'city', names: { 'zh-Hans': '宿州', en: 'Suzhou' }, partOf: china.id, location: SUZHOU_AH })
  assert.equal(lastRecord(next).placeId, suxian.id)
  assert.equal(Object.hasOwn(lastRecord(next), 'lat'), false)
  assert.deepEqual(placeNamed(next, 'Suzhou'), suzhou, '苏州不变')

  assertV2Error(() => addTravelRecord(files, { placeId: suzhou.id, start_date: '2026-05-03' }, ctx), 'E_CITY_EXISTS')
  // 再按名字提交苏州（同名同坐标）：强候选，界面默认选中。
  assertV2Error(() => addTravelRecord(files, suzhouInput('苏州', SUZHOU_JS), ctx), 'E_PLACE_CHOICE_REQUIRED', undefined, (error) => {
    assert.deepEqual(candidatesOf(error).map(({ placeId, strong, distanceKm }) => ({ placeId, strong, distanceKm })), [{ placeId: suzhou.id, strong: true, distanceKm: 0 }])
  })
})

test('同名不同城 · 反向场景：苏州只被想去引用，按名字提交宿州足迹 → E_PLACE_CHOICE_REQUIRED，不挂到苏州；用户选苏州的 placeId 才引用苏州（坐标取地点）', () => {
  const ctx = testContext()
  const base = migratedFiles()
  const files = applyWrites(base, addWantToGo(base, { place: { kind: 'city', nameZh: '苏州', nameEn: 'Suzhou', countryCode: 'CN', ...SUZHOU_JS } }, ctx).writes)
  const suzhou = placeNamed(files, 'Suzhou')
  const before = structuredClone(files)
  assertV2Error(() => addTravelRecord(files, suzhouInput('宿州', SUZHOU_AH), ctx), 'E_PLACE_CHOICE_REQUIRED', undefined, (error) => {
    assert.deepEqual(candidatesOf(error).map((candidate) => candidate.placeId), [suzhou.id])
  })
  assert.deepEqual(files, before, '没有挂到苏州上，也没有写任何文件')

  const chosen = addTravelRecord(files, { placeId: suzhou.id, start_date: '2026-05-01', lat: SUZHOU_AH.lat, lng: SUZHOU_AH.lng }, ctx)
  assert.deepEqual(writeOrder(chosen.writes), ['travel', 'editorState'])
  const next = applyWrites(files, chosen.writes)
  assertIntact(next)
  assert.equal(lastRecord(next).placeId, suzhou.id)
  assert.equal(Object.hasOwn(lastRecord(next), 'lat'), false, '记录坐标就是苏州的坐标，不会出现「身份是苏州，坐标是宿州」')
  assert.deepEqual(placeNamed(next, 'Suzhou').location, SUZHOU_JS)
  assert.equal(lastRecord(next).trip_title, '中国 · 苏州')
})

test('同名不同城 · 顺序无关：先苏州后宿州，与先宿州后苏州，第二个都要选择，明确新建后的地点与引用关系相同', () => {
  const run = (first: Record<string, unknown>, second: Record<string, unknown>) => {
    const ctx = testContext()
    const base = migratedFiles()
    let files = applyWrites(base, addTravelRecord(base, first, ctx).writes)
    assertV2Error(() => addTravelRecord(files, second, ctx), 'E_PLACE_CHOICE_REQUIRED')
    files = applyWrites(files, addTravelRecord(files, { ...second, createNew: true }, ctx).writes)
    assertIntact(files)
    const china = placeNamed(files, 'China', 'country')
    return files.places.places
      .filter((place) => place.partOf === china.id)
      .map((place) => ({ names: place.names, location: place.location, visits: files.travel.records.filter((record) => record.placeId === place.id).map((record) => record.start_date) }))
      .sort((left, right) => left.names['zh-Hans'].localeCompare(right.names['zh-Hans'], 'en'))
  }
  const js = suzhouInput('苏州', SUZHOU_JS, { start_date: '2026-05-01' })
  const ah = suzhouInput('宿州', SUZHOU_AH, { start_date: '2026-05-03' })
  const forward = run(js, ah)
  assert.equal(forward.length, 2)
  assert.deepEqual(forward, run(ah, js))
})

test('新增足迹 · 三种输入只能选一种：placeId 与名称字段或 createNew 混用、引用的不是城市、createNew 不是布尔值 → E_UNKNOWN_PLACE_REF；坐标须成对', () => {
  const files = migratedFiles()
  const before = structuredClone(files)
  const reykjavik = placeNamed(files, 'Reykjavik').id
  const nuuk = placeNamed(files, 'Nuuk').id
  const dates = { start_date: '2026-07-01' }
  for (const input of [
    { placeId: GHOST_ID, ...dates },
    { placeId: placeNamed(files, 'Iceland').id, ...dates },
    { placeId: '', ...dates },
    { placeId: 3, ...dates },
    { placeId: nuuk, city: '努克', ...dates },
    { placeId: nuuk, country_code: 'GL', ...dates },
    { placeId: nuuk, createNew: true, ...dates },
    { placeId: nuuk, createNew: false, ...dates },
    hofnInput({ createNew: 'yes' }),
  ]) assertV2Error(() => addTravelRecord(files, input, testContext()), 'E_UNKNOWN_PLACE_REF', undefined, () => {})
  assertV2Error(() => addTravelRecord(files, { placeId: nuuk, ...dates, lat: 64 }, testContext()), 'E_COORDINATES_PAIR')
  assertV2Error(() => addTravelRecord(files, { placeId: nuuk, ...dates, lat: 64, lng: 181 }, testContext()), 'E_NUMBER_INVALID', '经度无效。')
  assertV2Error(() => addTravelRecord(files, { placeId: reykjavik }, testContext()), 'E_REQUIRED', '请填写到访日期。')
  // createNew: false 与省略相同：按名字，没有候选就新建。
  assert.equal(applyWrites(files, addTravelRecord(files, hofnInput({ createNew: false }), testContext()).writes).places.places.length, files.places.places.length + 1)
  assert.deepEqual(files, before)
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

test('新增国家的大洲在添加首个及后续城市、隐藏全部城市后仍保留，不回写城市记录', () => {
  const ctx = testContext()
  let files = migratedFiles()
  files = applyWrites(files, addCountry(files, { countryCode: 'JP', visitedDate: '2026-05-01' }, ctx).writes)
  const japan = placeNamed(files, 'Japan').id
  const country = () => deriveAppDataFromCanonical(readV2(files), { now: WRITE_NOW.toISOString() }).travelAtlas.countryById[japan]
  const savedCountry = structuredClone(files.editorState.addedCountries)
  assert.deepEqual(country().keywords, ['Asia'])
  for (const [city, cityEn, lat, lng] of [['东京', 'Tokyo', 35.6762, 139.6503], ['京都', 'Kyoto', 35.0116, 135.7681]] as const) {
    files = applyWrites(files, addTravelRecord(files, {
      country: '日本', country_en: 'Japan', country_code: 'JP', city, city_en: cityEn,
      start_date: '2026-05-02', lat, lng,
    }, ctx).writes)
    assertIntact(files)
    const before = structuredClone(files)
    assert.deepEqual(country().keywords, ['Asia'])
    assert.equal(Object.hasOwn(lastRecord(files), 'region'), false)
    assert.deepEqual(files.editorState.addedCountries, savedCountry)
    assert.deepEqual(files, before, '派生显示信息不修改输入')
  }
  assert.equal(country().cityIds.length, 2)
  files.editorState.hiddenCityIds = [...files.editorState.hiddenCityIds, ...country().cityIds]
  assert.deepEqual(country().keywords, ['Asia'])
  assert.deepEqual(country().cityIds, [])
})

test('国家地区回退按国家 id 匹配：保留记录地区，没有国家地区时不猜测', () => {
  const ctx = testContext()
  let files = migratedFiles()
  files = applyWrites(files, addCountry(files, { countryCode: 'JP', visitedDate: '2026-05-01' }, ctx).writes)
  files = applyWrites(files, addTravelRecord(files, {
    country: '日本', country_en: 'Japan', country_code: 'JP', city: '东京', city_en: 'Tokyo',
    start_date: '2026-05-02', lat: 35.6762, lng: 139.6503,
  }, ctx).writes)
  const japan = placeNamed(files, 'Japan').id
  const derive = () => deriveAppDataFromCanonical(readV2(files), { now: WRITE_NOW.toISOString() }).travelAtlas
  lastRecord(files).region = 'East Asia'
  assert.deepEqual(derive().countryById[japan].keywords, ['East Asia'])
  delete lastRecord(files).region
  files.editorState.addedCountries[0].placeId = placeNamed(files, 'Iceland').id
  assert.deepEqual(derive().countryById[japan].keywords, [], '其他国家的地区不能套用')
  files.editorState.addedCountries[0].placeId = japan
  delete files.editorState.addedCountries[0].region
  assert.deepEqual(derive().countryById[japan].keywords, [], '缺失的地区保持未知')
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
