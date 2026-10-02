/**
 * queryCollection / filterCollection 的单元测试（PRD R10，PR7 规格 §3.1）。
 *
 * 运行方式：npm test。零依赖：只用 node:test + node:assert/strict。
 * fixture 手写，理由见 adapters/travel.test.ts：travelAtlas.ts 在 node --test 下无法加载。
 * 下面这行 reference 不能删，理由见 adapters/travel.test.ts 的同一段说明。
 */

/// <reference types="node" />

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { placesToWorldGraph, type PlaceInput } from './adapters/places.ts'
import { plannedRecordsToWorldGraph, PLANNED_SOURCE, type PlannedRecordInput } from './adapters/plannedRecords.ts'
import { wantToGoToWorldGraph, WANT_TO_GO_SOURCE, type WantToGoInput } from './adapters/wantToGo.ts'
import { filterCollection, queryCollection } from './collection.ts'
import { originalNameSubtitle, resolveName } from './localizedText.ts'
import type { CollectionEntry } from './collection.ts'
import { mergeWorldGraphSnapshots } from './snapshot.ts'
import type { Anchor, Entity, LayerMembership, WorldGraphSnapshot } from './types.ts'

const UI = 'zh-Hans'

const NOW = '2026-09-23T00:00:00.000Z'

test('All names remain searchable and displayed-name sorting follows the UI locale', () => {
  const entry = (entityId: string, zh: string, en: string): CollectionEntry => ({
    entityId, recordId: entityId, layerId: 'want_to_go', subtype: 'city',
    title: { names: { 'zh-Hans': zh, en } }, addedAt: NOW, addedBy: 'user', hidden: false, readOnly: false,
  })
  const entries = [entry('kyoto', '京都', 'Kyoto'), entry('tokyo', '东京', 'Tokyo')]
  assert.deepEqual(ids(filterCollection(entries, { text: 'Kyoto' }, UI)), ['kyoto'])
  assert.equal(resolveName(filterCollection(entries, { text: 'Kyoto' }, UI)[0].title, UI), '京都')
  assert.deepEqual(ids(filterCollection(entries, { sort: 'name' }, UI)), ['tokyo', 'kyoto'])
  assert.deepEqual(ids(filterCollection(entries, { sort: 'name' }, 'en')), ['kyoto', 'tokyo'])
  assert.deepEqual(ids(filterCollection(entries, { sort: 'recent' }, 'en')), ['kyoto', 'tokyo'])
  assert.deepEqual(ids(filterCollection(entries, { sort: 'country' }, 'en')), ['kyoto', 'tokyo'])
})

test('Collection preserves original-language names and copies the nested names object', () => {
  const tokyo = place('tokyo', '东京', { en: 'Tokyo' })
  tokyo.title.names.ja = '東京'
  tokyo.title.originalLanguage = 'ja'
  const snapshot: WorldGraphSnapshot = {
    entities: [tokyo], memberships: [{ entityId: 'tokyo', layerId: 'want_to_go', addedAt: NOW, addedBy: 'user' }],
    anchors: [], relations: [],
  }
  const [entry] = queryCollection(snapshot, 'want_to_go', UI)
  assert.equal(resolveName(entry.title, UI), '东京')
  assert.equal(originalNameSubtitle(entry.title, UI), '東京')
  assert.deepEqual(ids(filterCollection([entry], { text: '東京' }, UI)), ['tokyo'])
  entry.title.names.ja = 'changed'
  assert.equal(tokyo.title.names.ja, '東京')
})

const place = (
  id: string,
  zh: string,
  options: { en?: string; subtype?: Entity['subtype']; countryCode?: string } = {},
): Entity => ({
  id,
  type: 'place',
  subtype: options.subtype ?? 'city',
  title: { names: { 'zh-Hans': zh, ...(options.en === undefined ? {} : { en: options.en }) } },
  metadata: options.countryCode === undefined ? {} : { countryCode: options.countryCode },
  visibility: 'private',
  createdAt: NOW,
  updatedAt: NOW,
})

const member = (
  entityId: string,
  addedAt: string,
  metadata?: Record<string, unknown>,
  layerId: LayerMembership['layerId'] = 'want_to_go',
  addedBy: LayerMembership['addedBy'] = 'user',
): LayerMembership => (metadata === undefined
  ? { entityId, layerId, addedBy, addedAt }
  : { entityId, layerId, addedBy, addedAt, metadata })

const location = (entityId: string, lat: number, lng: number, precision: Anchor['precision'] = 'exact'): Anchor => ({
  id: `anchor:location:${entityId}`,
  entityId,
  kind: 'location',
  lat,
  lng,
  precision,
})

const snapshotOf = (partial: Partial<WorldGraphSnapshot>): WorldGraphSnapshot => ({
  entities: [],
  memberships: [],
  anchors: [],
  relations: [],
  ...partial,
})

const deepFreeze = <T>(value: T): T => {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key])
    }
    Object.freeze(value)
  }
  return value
}

const ids = (entries: readonly CollectionEntry[]) => entries.map((entry) => entry.entityId)

/**
 * 一份覆盖各种形态的小快照：
 * - nuuk：有坐标、有备注、user 添加
 * - tromso：有坐标、已隐藏
 * - akureyri：没有坐标（D06）
 * - iceland：整个国家条目，国家级精度
 * - planned：只读的 planned 记录
 * - reykjavik：只在 travel 图层（不该出现在 want_to_go 清单里）
 */
const mixedSnapshot = (): WorldGraphSnapshot => snapshotOf({
  entities: [
    place('p-nuuk', '努克', { en: 'Nuuk', countryCode: 'GL' }),
    place('p-tromsø', '特罗姆瑟', { en: 'Tromsø', countryCode: 'NO' }),
    place('p-akureyri', '阿克雷里', { en: 'Akureyri', countryCode: 'IS' }),
    place('p-iceland', '冰岛', { en: 'Iceland', subtype: 'country', countryCode: 'IS' }),
    place('p-bergen', '卑尔根', { en: 'Bergen', countryCode: 'NO' }),
    place('p-reykjavik', '雷克雅未克', { en: 'Reykjavik' }),
  ],
  memberships: [
    member('p-nuuk', '2026-09-10', { hidden: false, source: 'want-to-go', note: '格陵兰的首府' }),
    member('p-tromsø', '2026-09-12', { hidden: true, source: 'want-to-go', note: '冬季看极光' }),
    member('p-akureyri', '2026-09-12', { hidden: false, source: 'want-to-go' }),
    member('p-iceland', '2026-09-01', { hidden: false, source: 'want-to-go' }),
    member('p-bergen', '2027-05-01', { source: PLANNED_SOURCE, readOnly: true }, 'want_to_go', 'rule'),
    member('p-reykjavik', '2025-06-01', undefined, 'travel', 'rule'),
  ],
  anchors: [
    location('p-nuuk', 64.18, -51.69),
    location('p-tromsø', 69.65, 18.96),
    location('p-iceland', 64.9, -18.6, 'region'),
    location('p-bergen', 60.39, 5.32),
    location('p-reykjavik', 64.15, -21.94),
  ],
})

// ---------------------------------------------------------------------------
// 1. queryCollection：取哪些成员
// ---------------------------------------------------------------------------

test('空快照产出空清单', () => {
  assert.deepEqual(queryCollection(snapshotOf({}), 'want_to_go', UI), [])
})

test('只取指定图层的成员：想去清单里没有足迹城市，足迹清单里只有它', () => {
  const snapshot = mixedSnapshot()
  const wantToGo = queryCollection(snapshot, 'want_to_go', UI)
  assert.equal(wantToGo.length, 5)
  assert.ok(!ids(wantToGo).includes('p-reykjavik'))
  assert.ok(wantToGo.every((entry) => entry.layerId === 'want_to_go'))

  assert.deepEqual(ids(queryCollection(snapshot, 'travel', UI)), ['p-reykjavik'])
})

test('已隐藏与没有坐标的条目都在清单里（FR-LP-6 / D06）', () => {
  const entries = queryCollection(mixedSnapshot(), 'want_to_go', UI)
  const tromso = entries.find((entry) => entry.entityId === 'p-tromsø')
  const akureyri = entries.find((entry) => entry.entityId === 'p-akureyri')

  assert.equal(tromso?.hidden, true)
  assert.deepEqual(tromso?.location, { lat: 69.65, lng: 18.96, precision: 'exact' })
  assert.ok(akureyri)
  assert.equal(akureyri.hidden, false)
  assert.equal('location' in akureyri, false)
})

test('逐字段取值：readOnly / note / source / countryCode / addedBy / subtype / title / location', () => {
  const entries = queryCollection(mixedSnapshot(), 'want_to_go', UI)
  const byId = new Map(entries.map((entry) => [entry.entityId, entry]))

  assert.deepEqual(byId.get('p-nuuk'), {
    entityId: 'p-nuuk',
    layerId: 'want_to_go',
    subtype: 'city',
    title: { names: { 'zh-Hans': '努克', en: 'Nuuk' } },
    countryCode: 'GL',
    addedAt: '2026-09-10',
    addedBy: 'user',
    hidden: false,
    readOnly: false,
    note: '格陵兰的首府',
    source: 'want-to-go',
    location: { lat: 64.18, lng: -51.69, precision: 'exact' },
  })

  const bergen = byId.get('p-bergen')
  assert.equal(bergen?.readOnly, true)
  assert.equal(bergen?.addedBy, 'rule')
  assert.equal(bergen?.source, PLANNED_SOURCE)
  assert.equal(bergen && 'note' in bergen, false, '没有备注就不输出 note 键')

  const iceland = byId.get('p-iceland')
  assert.equal(iceland?.subtype, 'country')
  assert.equal(iceland?.location?.precision, 'region')
})

test('countryCode 统一大写；空串、形状不对或缺失时省略；空备注与空来源也省略', () => {
  const snapshot = snapshotOf({
    entities: [
      place('a', '甲', { countryCode: ' gl ' }),
      place('b', '乙', { countryCode: 'GRL' }),
      place('c', '丙', { countryCode: '' }),
      place('d', '丁'),
    ],
    memberships: [
      member('a', '2026-01-04', { note: '', source: '' }),
      member('b', '2026-01-03', { note: 42, source: null }),
      member('c', '2026-01-02'),
      member('d', '2026-01-01', { hidden: 'yes', readOnly: 'true' }),
    ],
  })
  const [a, b, c, d] = queryCollection(snapshot, 'want_to_go', UI)

  assert.equal(a.countryCode, 'GL')
  assert.equal('note' in a, false)
  assert.equal('source' in a, false)
  assert.equal('countryCode' in b, false)
  assert.equal('note' in b, false)
  assert.equal('source' in b, false)
  assert.equal('countryCode' in c, false)
  assert.equal(c.hidden, false)
  assert.equal(c.readOnly, false)
  assert.equal('countryCode' in d, false)
  assert.equal(d.hidden, false, 'hidden 只认布尔 true')
  assert.equal(d.readOnly, false, 'readOnly 只认布尔 true')
})

test('location 取第一条有限坐标的 location Anchor；time Anchor 与 NaN 坐标不算', () => {
  const snapshot = snapshotOf({
    entities: [place('a', '甲')],
    memberships: [member('a', '2026-01-01')],
    anchors: [
      { id: 't', entityId: 'a', kind: 'time', occurredAt: '2026-01-01', precision: 'exact' },
      { id: 'nan', entityId: 'a', kind: 'location', lat: Number.NaN, lng: 1, precision: 'exact' },
      location('a', 10, 20, 'city'),
      location('a', 30, 40),
    ],
  })
  assert.deepEqual(queryCollection(snapshot, 'want_to_go', UI)[0].location, { lat: 10, lng: 20, precision: 'city' })
})

test('非 place 的 Entity 与快照里不存在的 Entity 被忽略', () => {
  const snapshot = snapshotOf({
    entities: [
      { ...place('journey:d1', '第一天'), type: 'journey', subtype: undefined },
      place('a', '甲'),
    ],
    memberships: [
      member('journey:d1', '2026-01-02'),
      member('missing', '2026-01-03'),
      member('a', '2026-01-01'),
    ],
  })
  assert.deepEqual(ids(queryCollection(snapshot, 'want_to_go', UI)), ['a'])
})

test('同一 (entityId, layerId, recordId) 的重复成员关系只取第一条（没有 recordId 按空串算）', () => {
  const snapshot = snapshotOf({
    entities: [place('a', '甲')],
    memberships: [
      member('a', '2026-01-01', { note: '第一条' }),
      member('a', '2026-02-01', { note: '第二条', hidden: true }),
    ],
  })
  const entries = queryCollection(snapshot, 'want_to_go', UI)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].note, '第一条')
  assert.equal(entries[0].addedAt, '2026-01-01')
  assert.equal(entries[0].hidden, false)
  assert.equal('recordId' in entries[0], false)
})

test('同一实体在这个图层的不同记录各列一行，recordId 写进条目（Core 方案 C3）', () => {
  const withRecord = (recordId: string, addedAt: string, metadata: Record<string, unknown>): LayerMembership => ({
    ...member('a', addedAt, metadata),
    recordId,
  })
  const snapshot = snapshotOf({
    entities: [place('a', '甲')],
    memberships: [
      withRecord('wtg_a', '2026-01-01', { note: '想去' }),
      withRecord('planned_a', '2026-02-01', { readOnly: true }),
      // 同一条记录的重复成员关系：只取第一条
      withRecord('wtg_a', '2026-03-01', { note: '重复' }),
    ],
  })
  const entries = queryCollection(snapshot, 'want_to_go', UI)
  assert.deepEqual(
    entries.map((entry) => [entry.entityId, entry.recordId, entry.addedAt, entry.readOnly, entry.note]),
    [
      ['a', 'planned_a', '2026-02-01', true, undefined],
      ['a', 'wtg_a', '2026-01-01', false, '想去'],
    ],
  )
})

test('重复的 Entity id 以第一个为准', () => {
  const snapshot = snapshotOf({
    entities: [place('a', '甲'), place('a', '冒名')],
    memberships: [member('a', '2026-01-01')],
  })
  assert.equal(queryCollection(snapshot, 'want_to_go', UI)[0].title.names['zh-Hans'], '甲')
})

// ---------------------------------------------------------------------------
// 2. 默认顺序
// ---------------------------------------------------------------------------

test('默认顺序：addedAt 降序 → 同日按中文名 → 再按 entityId', () => {
  const snapshot = snapshotOf({
    entities: [
      place('z-old', '阿'),
      place('b-same', '北京'),
      place('a-same', '北京'),
      place('c-same', '安徽'),
      place('new', '努克'),
    ],
    memberships: [
      member('z-old', '2026-01-01'),
      member('b-same', '2026-03-01'),
      member('a-same', '2026-03-01'),
      member('c-same', '2026-03-01'),
      member('new', '2026-05-01'),
    ],
  })
  assert.deepEqual(ids(queryCollection(snapshot, 'want_to_go', UI)), ['new', 'c-same', 'a-same', 'b-same', 'z-old'])
})

test('各排序在 entityId 之后以 recordId 作为最后的稳定键；没有 recordId 的排在前面', () => {
  const withRecord = (recordId: string | undefined): LayerMembership => (
    recordId === undefined ? member('a', '2026-03-01') : { ...member('a', '2026-03-01'), recordId }
  )
  const snapshot = snapshotOf({
    entities: [place('a', '甲', { countryCode: 'IS' })],
    memberships: [withRecord('r2'), withRecord('r1'), withRecord(undefined), withRecord('r10')],
  })
  const recordIds = (entries: readonly CollectionEntry[]) => entries.map((entry) => entry.recordId)
  const expected = [undefined, 'r1', 'r10', 'r2']
  const entries = queryCollection(snapshot, 'want_to_go', UI)
  assert.deepEqual(recordIds(entries), expected)
  const reversed = [...entries].reverse()
  for (const sort of ['recent', 'name', 'country'] as const) {
    assert.deepEqual(recordIds(filterCollection(reversed, { sort }, UI)), expected, sort)
  }
})

test('混合快照的默认顺序', () => {
  assert.deepEqual(ids(queryCollection(mixedSnapshot(), 'want_to_go', UI)), [
    'p-bergen',
    'p-akureyri',
    'p-tromsø',
    'p-nuuk',
    'p-iceland',
  ])
})

// ---------------------------------------------------------------------------
// 3. filterCollection：排序
// ---------------------------------------------------------------------------

test('sort 缺省与 recent 都是默认顺序，且会把乱序输入重新排好', () => {
  const entries = queryCollection(mixedSnapshot(), 'want_to_go', UI)
  const shuffled = [...entries].reverse()
  assert.deepEqual(ids(filterCollection(shuffled, {}, UI)), ids(entries))
  assert.deepEqual(ids(filterCollection(shuffled, { sort: 'recent' }, UI)), ids(entries))
})

test('sort: name 按中文名的中文 locale 升序', () => {
  const entries = queryCollection(mixedSnapshot(), 'want_to_go', UI)
  const expected = [...entries]
    .map((entry) => entry.title.names['zh-Hans'])
    .sort((left, right) => left.localeCompare(right, 'zh-CN'))
  assert.deepEqual(filterCollection(entries, { sort: 'name' }, UI).map((entry) => entry.title.names['zh-Hans']), expected)
})

test('sort: country 按国家代码升序，没有国家代码的排最后，同国再按名称', () => {
  const snapshot = snapshotOf({
    entities: [
      place('none', '无国家'),
      place('no-2', '特罗姆瑟', { countryCode: 'NO' }),
      place('gl', '努克', { countryCode: 'GL' }),
      place('no-1', '卑尔根', { countryCode: 'NO' }),
    ],
    memberships: [
      member('none', '2026-04-01'),
      member('no-2', '2026-03-01'),
      member('gl', '2026-02-01'),
      member('no-1', '2026-01-01'),
    ],
  })
  const entries = queryCollection(snapshot, 'want_to_go', UI)
  const noNames = ['特罗姆瑟', '卑尔根'].sort((left, right) => left.localeCompare(right, 'zh-CN'))
  assert.deepEqual(
    filterCollection(entries, { sort: 'country' }, UI).map((entry) => entry.title.names['zh-Hans']),
    ['努克', ...noNames, '无国家'],
  )
})

// ---------------------------------------------------------------------------
// 4. filterCollection：文本搜索
// ---------------------------------------------------------------------------

test('文本搜索：中文名、英文名、国家代码、备注都参与匹配', () => {
  const entries = queryCollection(mixedSnapshot(), 'want_to_go', UI)
  assert.deepEqual(ids(filterCollection(entries, { text: '努克' }, UI)), ['p-nuuk'])
  assert.deepEqual(ids(filterCollection(entries, { text: 'bergen' }, UI)), ['p-bergen'])
  assert.deepEqual(ids(filterCollection(entries, { text: 'gl' }, UI)), ['p-nuuk'])
  assert.deepEqual(ids(filterCollection(entries, { text: '极光' }, UI)), ['p-tromsø'])
})

test('文本搜索大小写不敏感，并先做 NFKC 规范化（全角字母也能匹配）', () => {
  const entries = queryCollection(mixedSnapshot(), 'want_to_go', UI)
  assert.deepEqual(ids(filterCollection(entries, { text: 'NUUK' }, UI)), ['p-nuuk'])
  assert.deepEqual(ids(filterCollection(entries, { text: 'ＮＵＵＫ' }, UI)), ['p-nuuk'])
  assert.deepEqual(ids(filterCollection(entries, { text: 'tromsø' }, UI)), ['p-tromsø'])
})

test('文本搜索先 trim：前后空白不影响匹配，全是空白等于不过滤', () => {
  const entries = queryCollection(mixedSnapshot(), 'want_to_go', UI)
  assert.deepEqual(ids(filterCollection(entries, { text: '  nuuk \t' }, UI)), ['p-nuuk'])
  assert.deepEqual(ids(filterCollection(entries, { text: '   ' }, UI)), ids(entries))
  assert.deepEqual(ids(filterCollection(entries, { text: '' }, UI)), ids(entries))
})

test('国家代码参与匹配：搜 is 命中冰岛的两个条目', () => {
  const entries = queryCollection(mixedSnapshot(), 'want_to_go', UI)
  assert.deepEqual(ids(filterCollection(entries, { text: 'is' }, UI)), [
    'p-akureyri',
    'p-iceland',
  ])
})

test('字段之间不会拼出假匹配', () => {
  const snapshot = snapshotOf({
    entities: [place('a', '甲', { en: 'Ab', countryCode: 'CD' })],
    memberships: [member('a', '2026-01-01')],
  })
  const entries = queryCollection(snapshot, 'want_to_go', UI)
  assert.deepEqual(filterCollection(entries, { text: 'bc' }, UI), [])
  assert.equal(filterCollection(entries, { text: 'ab' }, UI).length, 1)
})

// ---------------------------------------------------------------------------
// 5. filterCollection：状态筛选与组合
// ---------------------------------------------------------------------------

test('状态筛选：all / visible / hidden', () => {
  const entries = queryCollection(mixedSnapshot(), 'want_to_go', UI)
  assert.equal(filterCollection(entries, { status: 'all' }, UI).length, 5)
  assert.deepEqual(ids(filterCollection(entries, { status: 'hidden' }, UI)), ['p-tromsø'])
  assert.deepEqual(ids(filterCollection(entries, { status: 'visible' }, UI)), [
    'p-bergen',
    'p-akureyri',
    'p-nuuk',
    'p-iceland',
  ])
})

test('搜索、状态与排序可以组合', () => {
  const entries = queryCollection(mixedSnapshot(), 'want_to_go', UI)
  assert.deepEqual(ids(filterCollection(entries, { text: 'no', status: 'visible', sort: 'name' }, UI)), [
    'p-bergen',
  ])
  assert.deepEqual(filterCollection(entries, { text: '极光', status: 'visible' }, UI), [])
})

// ---------------------------------------------------------------------------
// 6. 纯函数
// ---------------------------------------------------------------------------

test('queryCollection 不修改输入快照，输出不与输入共享对象', () => {
  const snapshot = deepFreeze(mixedSnapshot())
  const entries = queryCollection(snapshot, 'want_to_go', UI)
  assert.deepEqual(queryCollection(snapshot, 'want_to_go', UI), entries)

  const nuuk = entries.find((entry) => entry.entityId === 'p-nuuk')
  const entity = snapshot.entities.find((item) => item.id === 'p-nuuk')
  assert.ok(nuuk && entity)
  assert.notEqual(nuuk.title, entity.title)
})

test('filterCollection 不修改输入数组与其中的对象，返回新数组', () => {
  const entries = deepFreeze(queryCollection(mixedSnapshot(), 'want_to_go', UI))
  const before = ids(entries)
  const sorted = filterCollection(entries, { sort: 'name' }, UI)
  assert.notEqual(sorted, entries)
  assert.deepEqual(ids(entries), before)
  assert.notEqual(filterCollection(entries, {}, UI), entries)
})

// ---------------------------------------------------------------------------
// 7. 与 App 数据流一致的集成用例
// ---------------------------------------------------------------------------

test('集成：title / countryCode / location 来自地点实体，记录级字段来自成员关系；想去与 planned 同在 want_to_go 清单里，planned 只读', () => {
  const places: PlaceInput[] = [
    { id: 'p-gl', subtype: 'country', title: { names: { 'zh-Hans': '格陵兰', en: 'Greenland' } }, countryCode: 'GL' },
    { id: 'p-nuuk', subtype: 'city', title: { names: { 'zh-Hans': '努克', en: 'Nuuk' } }, countryCode: 'GL', partOf: 'p-gl', location: { lat: 64.18, lng: -51.69 } },
    { id: 'p-fo', subtype: 'country', title: { names: { 'zh-Hans': '法罗群岛', en: 'Faroe Islands' } }, countryCode: 'FO' },
    { id: 'p-no', subtype: 'country', title: { names: { 'zh-Hans': '挪威', en: 'Norway' } }, countryCode: 'NO' },
    { id: 'p-bergen', subtype: 'city', title: { names: { 'zh-Hans': '卑尔根', en: 'Bergen' } }, countryCode: 'NO', partOf: 'p-no', location: { lat: 60.39, lng: 5.32 } },
    { id: 'p-longyearbyen', subtype: 'city', title: { names: { 'zh-Hans': '朗伊尔城', en: 'Longyearbyen' } }, countryCode: 'NO', partOf: 'p-no' },
  ]
  const items: WantToGoInput[] = [
    { id: 'wtg_2026-09-10_nuuk', placeId: 'p-nuuk', note: '格陵兰的首府', addedAt: '2026-09-10', hidden: false },
    { id: 'wtg_2026-09-11_faroe', placeId: 'p-fo', addedAt: '2026-09-11', hidden: true },
  ]
  const records: PlannedRecordInput[] = [
    { id: 'planned-bergen', placeId: 'p-bergen', start_date: '2027-05-01' },
    { id: 'planned-no-coords', placeId: 'p-longyearbyen', start_date: '2027-07-01' },
  ]

  // 与 App 的合并顺序一致：places → want-to-go → planned。
  const snapshot = mergeWorldGraphSnapshots(
    placesToWorldGraph(places, { now: NOW }),
    wantToGoToWorldGraph(items),
    plannedRecordsToWorldGraph(records),
  )
  const entries = queryCollection(snapshot, 'want_to_go', UI)
  const byRecordId = new Map(entries.map((entry) => [entry.recordId, entry]))

  // 每一行都带着它背后的记录 id：想去条目的 item.id、planned 的 record.id；实体 id 是地点 id。
  assert.deepEqual(entries.map((entry) => [entry.entityId, entry.recordId]), [
    ['p-longyearbyen', 'planned-no-coords'],
    ['p-bergen', 'planned-bergen'],
    ['p-fo', 'wtg_2026-09-11_faroe'],
    ['p-nuuk', 'wtg_2026-09-10_nuuk'],
  ])

  assert.deepEqual(byRecordId.get('wtg_2026-09-10_nuuk'), {
    entityId: 'p-nuuk',
    layerId: 'want_to_go',
    recordId: 'wtg_2026-09-10_nuuk',
    subtype: 'city',
    title: { names: { 'zh-Hans': '努克', en: 'Nuuk' } },
    countryCode: 'GL',
    addedAt: '2026-09-10',
    addedBy: 'user',
    hidden: false,
    readOnly: false,
    note: '格陵兰的首府',
    source: WANT_TO_GO_SOURCE,
    location: { lat: 64.18, lng: -51.69, precision: 'exact' },
  })

  const faroe = byRecordId.get('wtg_2026-09-11_faroe')
  assert.equal(faroe?.hidden, true)
  assert.equal(faroe?.subtype, 'country')
  assert.equal(faroe && 'location' in faroe, false)

  const bergen = byRecordId.get('planned-bergen')
  assert.equal(bergen?.readOnly, true)
  assert.equal(bergen?.source, PLANNED_SOURCE)
  assert.equal(bergen?.countryCode, 'NO')
  assert.deepEqual(bergen?.location, { lat: 60.39, lng: 5.32, precision: 'exact' }, '地点的规范坐标')

  const noCoords = byRecordId.get('planned-no-coords')
  assert.equal(noCoords?.readOnly, true)
  assert.equal(noCoords && 'location' in noCoords, false)
})

test('集成：引用的地点不在快照里时，这条记录不进清单（成员关系悬空）', () => {
  const snapshot = mergeWorldGraphSnapshots(
    placesToWorldGraph([], { now: NOW }),
    wantToGoToWorldGraph([{ id: 'wtg_orphan', placeId: 'p-missing', addedAt: '2026-09-10', hidden: false }]),
  )
  assert.deepEqual(queryCollection(snapshot, 'want_to_go', UI), [])
})
