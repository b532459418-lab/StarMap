/**
 * convert-to-travel.mjs 的单元测试（StarMap V0.4 PR9 规格 §3.1）。
 *
 * 运行方式：npm test（node --test 同时覆盖 src/**\/*.test.ts 与 scripts/**\/*.test.mjs）。
 * 零依赖：只用 node:test + node:assert/strict。被测函数都是纯函数，不需要临时目录。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildTravelRecordInput, convertPlannedRecord, resolveTravelCountry } from './convert-to-travel.mjs'

const iceland = () => ({
  id: 'sample_reykjavik',
  country: '冰岛',
  country_en: 'Iceland',
  country_code: 'is',
  city: '雷克雅未克',
  city_en: 'Reykjavik',
  start_date: '2025-06-01',
  status: 'visited',
  lat: 64.1466,
  lng: -21.9426,
})

const catalogByCode = new Map([
  ['GL', { nameZh: '格陵兰', nameEn: 'Greenland' }],
  ['IS', { nameZh: '冰岛（目录）', nameEn: 'Iceland (catalog)' }],
  ['NO', { nameZh: '挪威', nameEn: 'Norway' }],
])

const nuukItem = (overrides = {}) => ({
  id: 'wtg_2026-09-17_nuuk',
  place: { kind: 'city', nameZh: '努克', nameEn: 'Nuuk', countryCode: 'GL', lat: 64.1814, lng: -51.6941 },
  note: '格陵兰首府',
  addedAt: '2026-09-17',
  hidden: false,
  source: 'local-editor',
  ...overrides,
})

const greenland = { country: '格陵兰', country_en: 'Greenland', country_code: 'GL' }

// ---------------------------------------------------------------------------
// resolveTravelCountry()
// ---------------------------------------------------------------------------

test('国家名第 1 级：用 country_code 相同的第一条旅行记录，代码不分大小写', () => {
  const records = [
    { ...iceland(), country_code: 'IS' },
    { ...iceland(), id: 'second', country: '冰岛（第二条）', country_en: 'Iceland 2' },
  ]
  assert.deepEqual(
    resolveTravelCountry('is', { records, countryCodes: { 'Iceland 2': 'is' }, catalogByCode }),
    { country: '冰岛', country_en: 'Iceland', country_code: 'IS' },
  )
  // 记录上的代码是小写、查询用大写也一样命中。
  assert.deepEqual(
    resolveTravelCountry(' IS ', { records: [iceland()], catalogByCode }),
    { country: '冰岛', country_en: 'Iceland', country_code: 'IS' },
  )
})

test('国家名第 2 级：display.countryCodes 映射到该代码、且有记录使用这个 country_en', () => {
  const record = { ...iceland(), country_code: undefined }
  assert.deepEqual(
    resolveTravelCountry('IS', {
      records: [record],
      // 映射到同一代码但没有记录使用的名字要跳过。
      countryCodes: { 'Iceland Old': 'is', Iceland: 'IS' },
      addedCountries: [{ id: 'iceland-added', nameZh: '冰岛（手动）', nameEn: 'Iceland Added', countryCode: 'is' }],
      catalogByCode,
    }),
    { country: '冰岛', country_en: 'Iceland', country_code: 'IS' },
  )
})

test('国家名第 3 级：编辑状态 addedCountries 里代码相同的国家', () => {
  assert.deepEqual(
    resolveTravelCountry('gl', {
      records: [iceland()],
      countryCodes: { Iceland: 'is' },
      addedCountries: [{ id: 'greenland', nameZh: '格陵兰岛', nameEn: 'Greenland', countryCode: 'gl' }],
      catalogByCode,
    }),
    { country: '格陵兰岛', country_en: 'Greenland', country_code: 'GL' },
  )
})

test('国家名第 4 级：国家目录', () => {
  assert.deepEqual(
    resolveTravelCountry('NO', { records: [iceland()], countryCodes: { Iceland: 'is' }, addedCountries: [], catalogByCode }),
    { country: '挪威', country_en: 'Norway', country_code: 'NO' },
  )
})

test('四级都找不到、或代码无效时报错', () => {
  assert.throws(
    () => resolveTravelCountry('ZZ', { records: [iceland()], catalogByCode }),
    /无法确定这个国家在足迹中的名称。/,
  )
  assert.throws(
    () => resolveTravelCountry('GRL', { records: [iceland()], catalogByCode }),
    /无法确定这个国家在足迹中的名称。/,
  )
  assert.throws(
    () => resolveTravelCountry(undefined, {}),
    /无法确定这个国家在足迹中的名称。/,
  )
})

// ---------------------------------------------------------------------------
// buildTravelRecordInput()
// ---------------------------------------------------------------------------

test('buildTravelRecordInput 正常输出：不带想去备注，结束日期与行程标题可选', () => {
  assert.deepEqual(
    buildTravelRecordInput(nuukItem(), { country: greenland, startDate: '2026-09-01', endDate: '2026-09-03', tripTitle: '  北极之行  ' }),
    {
      country: '格陵兰',
      country_en: 'Greenland',
      country_code: 'GL',
      city: '努克',
      city_en: 'Nuuk',
      start_date: '2026-09-01',
      end_date: '2026-09-03',
      lat: 64.1814,
      lng: -51.6941,
      trip_title: '北极之行',
    },
  )

  const minimal = buildTravelRecordInput(nuukItem(), { country: greenland, startDate: '2026-09-01', endDate: '', tripTitle: '   ' })
  assert.equal('end_date' in minimal, false)
  assert.equal('trip_title' in minimal, false)
  assert.equal('notes' in minimal, false)
  assert.equal(JSON.stringify(minimal).includes('格陵兰首府'), false)
})

test('buildTravelRecordInput 拒绝整个国家、无坐标与已隐藏的条目', () => {
  const options = { country: greenland, startDate: '2026-09-01' }
  assert.throws(
    () => buildTravelRecordInput(nuukItem({ place: { kind: 'country', nameZh: '格陵兰', nameEn: 'Greenland', countryCode: 'GL', lat: 72, lng: -40 } }), options),
    /整个国家的想去需要先具体到城市，暂不支持直接转为足迹。/,
  )
  assert.throws(
    () => buildTravelRecordInput(nuukItem({ place: { kind: 'city', nameZh: '努克', nameEn: 'Nuuk', countryCode: 'GL' } }), options),
    /这个地点没有坐标，无法转为足迹。/,
  )
  assert.throws(
    () => buildTravelRecordInput(nuukItem({ hidden: true }), options),
    /已隐藏的想去条目不能转为足迹。/,
  )
})

test('buildTravelRecordInput 在写入之前就拒绝缺失或格式错误的日期', () => {
  assert.throws(() => buildTravelRecordInput(nuukItem(), { country: greenland }), /请填写到访日期。/)
  assert.throws(
    () => buildTravelRecordInput(nuukItem(), { country: greenland, startDate: '2026/09/01' }),
    /到访日期必须使用 YYYY-MM-DD。/,
  )
  assert.throws(
    () => buildTravelRecordInput(nuukItem(), { country: greenland, startDate: '2026-09-01', endDate: '9/3' }),
    /结束日期必须使用 YYYY-MM-DD。/,
  )
  assert.throws(
    () => buildTravelRecordInput(nuukItem(), { country: greenland, startDate: '2026-09-03', endDate: '2026-09-01' }),
    /结束日期不能早于到访日期。/,
  )
})

// ---------------------------------------------------------------------------
// convertPlannedRecord()
// ---------------------------------------------------------------------------

const plannedMap = () => ({
  schema_version: 1,
  generated_at: '2026-01-01T00:00:00.000Z',
  records: [
    iceland(),
    {
      id: 'planned_bergen',
      country: '挪威',
      country_en: 'Norway',
      country_code: 'no',
      city: '卑尔根',
      city_en: 'Bergen',
      start_date: '2027-05-01',
      end_date: '2027-05-04',
      year: 2027,
      trip_title: 'Fjords',
      type: 'visit',
      status: 'planned',
      lat: 60.3913,
      lng: 5.3221,
      notes: '峡湾',
    },
    {
      id: 'planned_nowhere',
      country: '挪威',
      country_en: 'Norway',
      city: '某地',
      city_en: 'Somewhere',
      start_date: '2027-06-01',
      status: 'planned',
      lat: null,
      lng: null,
    },
  ],
})

test('convertPlannedRecord 正常路径：只改 status / 日期 / year，不新增记录', () => {
  const input = plannedMap()
  const { travelMap, record } = convertPlannedRecord(input, 'planned_bergen', { startDate: '2026-08-10', endDate: '2026-08-12' })
  assert.deepEqual(record, {
    ...input.records[1],
    status: 'visited',
    start_date: '2026-08-10',
    end_date: '2026-08-12',
    year: 2026,
  })
  assert.equal(travelMap.records.length, 3)
  assert.equal(travelMap.records[1], record)
  assert.equal(travelMap.records[0], input.records[0])
  assert.equal(travelMap.generated_at, input.generated_at)
})

test('convertPlannedRecord 没填结束日期时删除 end_date 键', () => {
  const { record } = convertPlannedRecord(plannedMap(), 'planned_bergen', { startDate: '2026-08-10' })
  assert.equal('end_date' in record, false)
  assert.equal(record.year, 2026)
})

test('convertPlannedRecord 拒绝不存在、非 planned 与无坐标的记录', () => {
  const options = { startDate: '2026-08-10' }
  assert.throws(() => convertPlannedRecord(plannedMap(), 'missing', options), /找不到这条旅行计划。/)
  assert.throws(() => convertPlannedRecord(plannedMap(), 'sample_reykjavik', options), /找不到这条旅行计划。/)
  assert.throws(() => convertPlannedRecord({}, 'planned_bergen', options), /找不到这条旅行计划。/)
  assert.throws(
    () => convertPlannedRecord(plannedMap(), 'planned_nowhere', options),
    /这条旅行计划没有坐标，无法转为足迹。/,
  )
})

test('convertPlannedRecord 校验日期', () => {
  assert.throws(() => convertPlannedRecord(plannedMap(), 'planned_bergen', {}), /请填写到访日期。/)
  assert.throws(
    () => convertPlannedRecord(plannedMap(), 'planned_bergen', { startDate: '2026-08-10', endDate: '2026-08-01' }),
    /结束日期不能早于到访日期。/,
  )
})

test('convertPlannedRecord 不修改输入', () => {
  const input = plannedMap()
  const snapshot = structuredClone(input)
  const { travelMap } = convertPlannedRecord(input, 'planned_bergen', { startDate: '2026-08-10' })
  assert.deepEqual(input, snapshot)
  assert.notEqual(travelMap, input)
  assert.notEqual(travelMap.records, input.records)
})
