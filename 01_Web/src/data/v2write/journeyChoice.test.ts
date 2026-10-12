/**
 * 同名行程的选择（v2write/journeyChoice.ts，第 2C 批）的单元测试：候选行程与 `journeyIdFor`。
 *
 * 运行方式：npm test。零依赖：Node 24 自带类型剥离，只用 node:test + node:assert/strict。
 */

/// <reference types="node" />

import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { V2Files, V2TravelRecord } from '../canonical/v2Schema.ts'
import { JOURNEY_CANDIDATE_CITY_LIMIT, findJourneyCandidates, journeyIdFor } from './journeyChoice.ts'
import { assertV2Error, migratedFiles, placeNamed, testContext } from './v2write.fixture.ts'

const SUMMER = '暑假'

type RecordSpec = { id: string; city: string; start: string; end?: string; title?: string; journeyId?: string; status?: string }

/** 在迁移后的中性数据上追加记录（城市按英文名找）。 */
const withRecords = (specs: RecordSpec[], files: V2Files = migratedFiles()): V2Files => {
  for (const spec of specs) {
    const record: V2TravelRecord = {
      id: spec.id,
      placeId: placeNamed(files, spec.city, 'city').id,
      start_date: spec.start,
      ...(spec.end ? { end_date: spec.end } : {}),
      year: Number(spec.start.slice(0, 4)),
      ...(spec.title !== undefined ? { trip_title: spec.title } : {}),
      type: 'visit',
      status: spec.status ?? 'visited',
      source: 'local-editor',
      ...(spec.journeyId !== undefined ? { journeyId: spec.journeyId } : {}),
    }
    files.travel.records.push(record)
  }
  return files
}

const names = (files: V2Files, en: string) => {
  const place = placeNamed(files, en, 'city')
  return { placeId: place.id, names: { 'zh-Hans': place.names['zh-Hans'], en: place.names.en } }
}

/** 两次往年的「暑假」（2024 与 2023），再加几条不该成为候选的记录。 */
const twoSummers = () => withRecords([
  { id: 's24_akureyri', city: 'Akureyri', start: '2024-07-04', end: '2024-07-10', title: SUMMER, journeyId: 'journey-summer-2024' },
  { id: 's24_reykjavik', city: 'Reykjavik', start: '2024-07-01', end: '2024-07-03', title: SUMMER, journeyId: 'journey-summer-2024' },
  { id: 's23_torshavn', city: 'Torshavn', start: '2023-07-05', title: SUMMER, journeyId: 'journey-summer-2023' },
  { id: 's23_gjogv', city: 'Gjogv', start: '2023-07-06', end: '2023-07-08', title: SUMMER, journeyId: 'journey-summer-2023' },
  // planned 不是已去过的行程；没有 journeyId 的记录不属于任何行程；标题不同的不是候选。
  { id: 'p_bergen', city: 'Bergen', start: '2026-07-01', title: SUMMER, status: 'planned' },
  { id: 'v_nuuk', city: 'Nuuk', start: '2022-07-01', title: SUMMER },
  { id: 'w_klaksvik', city: 'Klaksvik', start: '2024-12-24', title: '寒假', journeyId: 'journey-winter-2024' },
])

test('候选行程：同标题的两次往年旅行 → 两个候选，日期范围与城市都正确，最近的在前', () => {
  const files = twoSummers()
  assert.deepEqual(findJourneyCandidates(files, SUMMER), [
    {
      journeyId: 'journey-summer-2024',
      title: SUMMER,
      startDate: '2024-07-01',
      endDate: '2024-07-10',
      cities: [names(files, 'Reykjavik'), names(files, 'Akureyri')],
      cityCount: 2,
    },
    {
      journeyId: 'journey-summer-2023',
      title: SUMMER,
      startDate: '2023-07-05',
      endDate: '2023-07-08',
      cities: [names(files, 'Torshavn'), names(files, 'Gjogv')],
      cityCount: 2,
    },
  ])
})

test('候选行程：没有同名的已有行程 → 空（标题不同、只有 planned、只有不带 journeyId 的记录、标题为空）', () => {
  const files = twoSummers()
  assert.deepEqual(findJourneyCandidates(files, '国庆'), [])
  assert.deepEqual(findJourneyCandidates(files, '暑假 '), [], '完全相同才算，不 trim、不忽略大小写')
  assert.deepEqual(findJourneyCandidates(files, undefined), [])
  assert.deepEqual(findJourneyCandidates(files, ''), [])
  const onlyPlannedOrUnassigned = withRecords([
    { id: 'p_bergen', city: 'Bergen', start: '2026-07-01', title: '春节', status: 'planned', journeyId: 'journey-plan' },
    { id: 'v_nuuk', city: 'Nuuk', start: '2022-07-01', title: '春节', journeyId: '' },
  ])
  assert.deepEqual(findJourneyCandidates(onlyPlannedOrUnassigned, '春节'), [])
})

test('候选行程：描述整个行程——同一 journeyId 下标题不同的记录也计入日期与城市；城市去重、按到访先后、最多列 5 个并附总数', () => {
  const files = withRecords([
    { id: 'a', city: 'Reykjavik', start: '2021-08-01', title: SUMMER, journeyId: 'journey-long' },
    { id: 'b', city: 'Vik', start: '2021-08-02', title: SUMMER, journeyId: 'journey-long' },
    { id: 'c', city: 'Akureyri', start: '2021-08-03', title: '暑假 · 北部', journeyId: 'journey-long' },
    { id: 'd', city: 'Reykjavik', start: '2021-08-04', title: SUMMER, journeyId: 'journey-long' },
    { id: 'e', city: 'Torshavn', start: '2021-08-05', title: SUMMER, journeyId: 'journey-long' },
    { id: 'f', city: 'Gjogv', start: '2021-08-06', title: SUMMER, journeyId: 'journey-long' },
    { id: 'g', city: 'Klaksvik', start: '2021-08-07', end: '2021-08-09', title: '暑假 · 返程', journeyId: 'journey-long' },
  ])
  const [candidate, ...rest] = findJourneyCandidates(files, SUMMER)
  assert.equal(rest.length, 0)
  assert.equal(candidate.startDate, '2021-08-01')
  assert.equal(candidate.endDate, '2021-08-09', '最晚结束取自标题不同的那条')
  assert.equal(candidate.cityCount, 6)
  assert.equal(candidate.cities.length, JOURNEY_CANDIDATE_CITY_LIMIT)
  assert.deepEqual(candidate.cities, ['Reykjavik', 'Vik', 'Akureyri', 'Torshavn', 'Gjogv'].map((city) => names(files, city)))
  // 只有标题不同的记录属于这个行程时，它不是「暑假」的候选。
  assert.deepEqual(findJourneyCandidates(files, '暑假 · 返程').map((item) => item.journeyId), ['journey-long'])
})

test('候选行程：排序稳定——按最晚日期倒序，再按 journeyId；没有日期的排最后；与记录在文件里的顺序无关', () => {
  const specs: RecordSpec[] = [
    { id: 'x1', city: 'Reykjavik', start: '2024-07-01', end: '2024-07-10', title: SUMMER, journeyId: 'journey-b' },
    { id: 'x2', city: 'Vik', start: '2024-07-05', end: '2024-07-10', title: SUMMER, journeyId: 'journey-a' },
    { id: 'x3', city: 'Akureyri', start: '2025-01-01', title: SUMMER, journeyId: 'journey-c' },
    { id: 'x4', city: 'Torshavn', start: '', title: SUMMER, journeyId: 'journey-0-undated' },
  ]
  const expected = ['journey-c', 'journey-a', 'journey-b', 'journey-0-undated']
  assert.deepEqual(findJourneyCandidates(withRecords(specs), SUMMER).map((item) => item.journeyId), expected)
  assert.deepEqual(findJourneyCandidates(withRecords([...specs].reverse()), SUMMER).map((item) => item.journeyId), expected)
  const undated = findJourneyCandidates(withRecords(specs), SUMMER).at(-1)!
  assert.equal(Object.hasOwn(undated, 'startDate') || Object.hasOwn(undated, 'endDate'), false)
})

test('journeyIdFor：没有候选 → 新行程；有候选又没有选择 → E_JOURNEY_CHOICE_REQUIRED（附候选），不消耗 id', () => {
  const files = twoSummers()
  const ctx = testContext()
  const fresh = journeyIdFor(files, '国庆', ctx, { kind: 'ask' })
  assert.match(fresh, /^journey-[0-9a-f-]{36}$/)
  assert.equal(journeyIdFor(files, undefined, testContext(), { kind: 'ask' }), fresh, '标题为空也新建（同一个 id 序列）')

  let calls = 0
  const counting = testContext({ newId: () => { calls += 1; return 'unused' } })
  assertV2Error(() => journeyIdFor(files, SUMMER, counting, { kind: 'ask' }), 'E_JOURNEY_CHOICE_REQUIRED', '已有同名的行程，请选择加入已有行程，或新建一个行程。本次尚未保存。', (error) => {
    assert.equal(error.params?.tripTitle, SUMMER)
    assert.deepEqual(error.params?.candidates, findJourneyCandidates(files, SUMMER))
  })
  assert.equal(calls, 0)
})

test('journeyIdFor：加入同名的已有行程 → 沿用它的 journeyId；不是同名候选 → E_UNKNOWN_JOURNEY；新建 → 新行程（即使标题相同）', () => {
  const files = twoSummers()
  assert.equal(journeyIdFor(files, SUMMER, testContext(), { kind: 'join', journeyId: 'journey-summer-2023' }), 'journey-summer-2023')
  assert.equal(journeyIdFor(files, SUMMER, testContext(), { kind: 'join', journeyId: 'journey-summer-2024' }), 'journey-summer-2024')
  for (const journeyId of ['journey-winter-2024', 'journey-missing', '']) {
    assertV2Error(() => journeyIdFor(files, SUMMER, testContext(), { kind: 'join', journeyId }), 'E_UNKNOWN_JOURNEY', '要加入的行程不是同名的已有行程，未保存。请重新选择。', (error) => {
      assert.deepEqual(error.params, { journeyId })
    })
  }
  assertV2Error(() => journeyIdFor(files, '国庆', testContext(), { kind: 'join', journeyId: 'journey-summer-2024' }), 'E_UNKNOWN_JOURNEY')
  const created = journeyIdFor(files, SUMMER, testContext(), { kind: 'new' })
  assert.match(created, /^journey-[0-9a-f-]{36}$/)
  assert.ok(!files.travel.records.some((record) => record.journeyId === created))
})
