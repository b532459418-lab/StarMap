/**
 * Canonical 派生（canonical/derive.ts）的单元测试（RFC-LOC-1 PR2 规格 §2.1、§4；PR5b §4.1）。
 *
 * 运行方式：npm test。零依赖：Node 24 自带类型剥离，只用 node:test + node:assert/strict。
 *
 * PR2 到 PR5a 这里用三条路径互相对照（A = 旧派生跑原始数据，B = 旧派生跑 normalizeLegacy 之后的数据，
 * C = 新派生跑 Legacy Adapter 的输出），断言 B ≡ C。PR5b 删除了旧派生与 Legacy Adapter：
 * - 每个 fixture 的 C 输入冻结成静态的 Canonical（旧 id 空间，./frozen.fixture.ts）；冻结时它们的派生基线都等于 B；
 * - 文件末尾的锁定测试钉住全部冻结夹具与公开 V2 样例的派生基线哈希，取代 B ≡ C；
 * - 下面只留对新派生本身的断言（countryIdOfCity、写法统一、分类、editor-state、planned、媒体），输入换成冻结的 Canonical。
 *
 * 下面这行 reference 不能删，理由见 src/worldgraph/adapters/travel.test.ts 文件头。
 */

/// <reference types="node" />

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { PLANNED_SOURCE } from '../../worldgraph/adapters/plannedRecords.ts'
import { BASELINE_FORMAT, buildBaseline, stableStringify } from '../derive/baseline.ts'
import { canonicalForInputs, type V2FileInputs } from './canonicalForInputs.ts'
import { deriveAppDataFromCanonical } from './derive.ts'
import {
  LEGACY_ID_CANONICAL_NAMES,
  MIGRATED_CANONICAL_NAMES,
  V2_SPACE_CANONICAL_NAMES,
  canonicalForInputsFixture,
  countryOfCityUuidOf,
  legacyIdCanonical,
  migratedCanonical,
  v2SpaceCanonical,
  type LegacyIdCanonicalName,
} from './frozen.fixture.ts'
import type { CanonicalData } from './types.ts'

const NOW = '2000-01-01T00:00:00.000Z'

const sha256 = (text: string) => createHash('sha256').update(`${text}\n`).digest('hex')

/** 冻结的 Canonical → 派生（与 App 相同的 now 注入方式）。 */
const derive = (name: LegacyIdCanonicalName) => deriveAppDataFromCanonical(legacyIdCanonical(name), { now: NOW })

// ---------------------------------------------------------------------------
// 基线格式
// ---------------------------------------------------------------------------

/**
 * 公开样例（旧 id 空间）基线的历史哈希（只作记录）：@1 `eb91f172…`（PR1 公布）、@2 `8caf2cfb…`（PR3b-1）、
 * Core-A A1 之后的 @2 `2e34a237…`。A1 只做了加法，那时这里有一个测试把今天的基线逐步还原到前两个哈希。
 *
 * Core-A A2（地点实体与按身份合并）改的只有 World Graph：四份快照、地图与 Collection 查询，以及想去模块按实体 id 查条目的
 * 两张表（`wantToGoItemByEntityId` / `plannedRecordByEntityId`，A2 删除）。实体 id 与按名字的合并都变了，基线不能再逐步还原；
 * 两者的对照（旧实体 id → 地点 id 之后逐项比较，Core 方案 C8）只在 A2 的 PR 期间做过，不提交。
 * 下面锁定的是「World Graph 以外的部分」：去掉上述各项与格式标识后，与 A2 之前（A1 之后）逐字节相同。
 */
const OUTSIDE_WORLD_GRAPH_SHA256 = {
  /** 公开样例（旧 id 空间，`legacyIdCanonical('sample')`）。 */
  legacySample: 'ebd00174d7e170021b962c55b2daec5178c639d50e82d017fd39ae8db5b86f7e',
  /** 公开 V2 样例（`src/data/v2-sample/`）。 */
  v2Sample: '3bc4679bbb0eec94f9db0c43010d8ad0620d1cceee915232d9b5add94f4e96eb',
}

/** 基线 JSON 里与下面几项改动有关的部分（buildBaseline 返回 unknown）。 */
interface BaselineShape {
  format?: string
  modules: { travelAtlas: Record<string, unknown>; wantToGo: Record<string, unknown>; worldGraph: Record<string, unknown> }
  queries?: unknown
}

const SNAPSHOT_EXPORT_NAMES = ['travelSnapshot', 'wantToGoSnapshot', 'plannedSnapshot', 'worldGraphSnapshot'] as const

/** 去掉 Core-A A2 改动的部分（见上），剩下的就是「World Graph 以外的部分」。 */
const outsideWorldGraph = (baseline: BaselineShape): BaselineShape => {
  delete baseline.format
  delete baseline.queries
  for (const name of SNAPSHOT_EXPORT_NAMES) delete baseline.modules.worldGraph[name]
  delete baseline.modules.wantToGo.wantToGoItemByEntityId
  delete baseline.modules.wantToGo.plannedRecordByEntityId
  return baseline
}

test('基线：World Graph 以外的部分与 Core-A A2 之前逐字节相同（公开样例的旧 id 空间与 V2 两份）', () => {
  const baseline = buildBaseline(derive('sample'), { now: NOW }) as BaselineShape
  assert.equal(baseline.format, BASELINE_FORMAT)
  assert.deepEqual(baseline.modules.travelAtlas.countryIdOfCity, [
    ['iceland__reykjavik', 'iceland'],
    ['iceland__vik', 'iceland'],
    ['iceland__akureyri', 'iceland'],
    ['faroe-islands__torshavn', 'faroe-islands'],
    ['faroe-islands__gjogv', 'faroe-islands'],
  ])
  assert.equal(sha256(stableStringify(outsideWorldGraph(baseline))), OUTSIDE_WORLD_GRAPH_SHA256.legacySample)

  const v2Files = Object.fromEntries(Object.entries(V2_SAMPLE_FILE_NAMES).map(([key, name]) => [key, readJsonFile(`../v2-sample/${name}`)]))
  const v2Baseline = buildBaseline(deriveAppDataFromCanonical(canonicalForInputs({ v2Files, source: 'sample' }), { now: NOW }), { now: NOW })
  assert.equal(sha256(stableStringify(outsideWorldGraph(v2Baseline as BaselineShape))), OUTSIDE_WORLD_GRAPH_SHA256.v2Sample)
})

// ---------------------------------------------------------------------------
// countryIdOfCity
// ---------------------------------------------------------------------------

/**
 * countryIdOfCity 的数据（冻结的 `countryOfCity`）：显示中的城市、被 editor 隐藏的城市（维克）、hiddenFromHome 的城市
 * （阿克雷里）、只有 planned 的城市（卑尔根）、国家别名（Faeroe Islands → Faroe Islands 的克拉克斯维克），
 * 另在 hiddenCityIds 里放一个陈旧 id（前缀是 iceland__，但没有这座城市）。
 */
const COUNTRY_OF_CITY_EXPECTED: [string, string | undefined][] = [
  ['iceland__reykjavik', 'iceland'],
  ['iceland__vik', 'iceland'],
  ['iceland__akureyri', 'iceland'],
  ['norway__bergen', 'norway'],
  ['faroe-islands__klaksvik', 'faroe-islands'],
  // 陈旧 id：旧写法按前缀会算进 iceland，countryIdOfCity 不算（规格 §2.5 接受的唯一差异）。
  ['iceland__atlantis', undefined],
  // 别名前的写法、国家 id、不存在的 id 都不是城市。
  ['faeroe-islands__klaksvik', undefined],
  ['iceland', undefined],
  ['', undefined],
]

test('countryIdOfCity（Canonical 路径）：显示中、被 editor 隐藏、hiddenFromHome、只有 planned 的城市都查得到；陈旧 id 为 undefined', () => {
  const data = derive('countryOfCity')
  const derived = data.travelAtlas
  for (const [cityId, countryId] of COUNTRY_OF_CITY_EXPECTED) {
    assert.equal(derived.countryIdOfCity(cityId), countryId, `Canonical：${cityId}`)
  }
  // 被隐藏的城市不在 cityById 里——这正是 InfoCard 不能用 cityById 的原因。
  assert.equal(derived.cityById.iceland__vik, undefined)
  assert.equal(derived.cityById.norway__bergen, undefined)
  // 想去地点（旧 id 空间里每个条目一个）也是城市地点，按 partOf 回答。
  assert.equal(derived.countryIdOfCity('wtg:wtg_2026-08-12_akureyri'), 'iceland')

  // 基线的定义域 = 城市级函数的定义域 ∪ hiddenCityIds。
  const c = stableStringify(buildBaseline(data, { now: NOW }))
  assert.deepEqual(JSON.parse(c).modules.travelAtlas.countryIdOfCity, [
    ['iceland__reykjavik', 'iceland'],
    ['faroe-islands__klaksvik', 'faroe-islands'],
    ['iceland__vik', 'iceland'],
    ['iceland__atlantis', null],
  ])
})

test('countryIdOfCity（V2 id 空间）：地点 id 换成 UUID 后按 partOf 回答，被隐藏的城市同样查得到', () => {
  // 上一个测试的数据直接搬进 V2 的 id 空间（不合并）。
  const data = v2SpaceCanonical('countryOfCity')
  const uuidOf = countryOfCityUuidOf()
  const derived = deriveAppDataFromCanonical(data, { now: NOW }).travelAtlas
  for (const [cityId, countryId] of COUNTRY_OF_CITY_EXPECTED) {
    const uuid = uuidOf.get(cityId)
    if (uuid === undefined) continue
    assert.equal(derived.countryIdOfCity(uuid), countryId === undefined ? undefined : uuidOf.get(countryId), cityId)
  }
  assert.equal(derived.countryIdOfCity(uuidOf.get('iceland')!), undefined)
  assert.equal(derived.countryIdOfCity('iceland__vik'), undefined)
})

// ---------------------------------------------------------------------------
// 各 fixture 上的新派生
// ---------------------------------------------------------------------------

test('PR1 审查记录的名称不一致数据（七类）：写法统一成地点名称；拆分城市仍是两个城市；国旗取地点的代码', () => {
  const canonical = derive('nameInconsistency').travelAtlas
  // 统一写法后：行程日标题用地点名称；拆分城市仍是两个城市。
  assert.equal(canonical.journeyDays.find((day) => day.id === 'mismatch_city_en_case')?.title, 'Reykjavik visit')
  assert.ok(canonical.cityById['faroe-islands__tórshavn'])
  assert.ok(canonical.cityById['faroe-islands__torshavn'])
  // 国旗取代表记录（样例的 fo），不受 dk 记录影响。
  assert.equal(canonical.countryById['faroe-islands'].flagCode, 'fo')
  assert.equal(canonical.cityById['faroe-islands__gjogv'].records?.find((item) => item.id === 'mismatch_country_code')?.country_code, 'fo')
})

test('国家别名 + regionSuffix：别名并进同一国家，region 追加后缀，planned 记录同样', () => {
  const derived = derive('alias').travelAtlas
  assert.deepEqual(derived.countries.map((country) => [country.id, country.cityIds, country.keywords]), [
    ['faroe-islands', ['faroe-islands__torshavn', 'faroe-islands__klaksvik'], ['North Atlantic', 'Nordoyar']],
  ])
  assert.equal(derived.plannedRecords[0].region, 'Islands / Nordoyar')
  assert.equal(derived.routes[0].type, 'main')
})

test('hiddenCountries / originCountries / regionMatchers 分类（一致写法）：不上首页的记录与分类；导航隐藏的城市', () => {
  const derived = derive('classificationConsistent').travelAtlas
  assert.deepEqual(derived.hiddenHomeRecords.map((item) => [item.id, item.travelCategory]), [['home', 'origin'], ['override', 'destination']])
  assert.equal(derived.shouldHideCityFromNavigation(derived.cityById['faroe-islands__torshavn']), true)
  assert.equal(derived.shouldHideCityFromNavigation(derived.cityById['iceland__reykjavik']), false)
})

test('editor 隐藏国家与城市、排序', () => {
  const derived = derive('editorHidden').travelAtlas
  assert.deepEqual(derived.countries.map((country) => [country.id, country.cityIds]), [['iceland', ['iceland__akureyri', 'iceland__reykjavik']]])
  assert.deepEqual(derived.cities.map((city) => city.id), ['iceland__reykjavik', 'iceland__akureyri'])
})

test('addedCountries：同键条目在国家全部隐藏时作为独立国家出现，名称、代码、坐标取自地点', () => {
  for (const hiddenFromHome of [false, true]) {
    const derived = derive(hiddenFromHome ? 'addedCountriesHomeHidden' : 'addedCountriesShown').travelAtlas
    const standalone = derived.countries.filter((country) => country.records?.length === 0).map((country) => [country.id, country.nameZh, country.flagCode, country.centerLat])
    if (hiddenFromHome) {
      // 足迹记录都不上首页：同键条目作为独立国家出现，名称、代码、坐标取自地点（没有的才用条目自己的）。
      assert.deepEqual(standalone, [['iceland', '冰岛', 'is', 64.1466], ['greenland', '格陵兰', 'gl', 72], ['norway', '挪威', '', 60]])
    } else {
      assert.deepEqual(standalone, [['greenland', '格陵兰', 'gl', 72]])
    }
  }
})

test('planned 记录：与 visited 同城、只有 planned 的城市与国家', () => {
  const derived = derive('planned')
  assert.deepEqual(derived.travelAtlas.plannedRecords.map((item) => item.id), ['same-city', 'planned-only', 'planned-no-coordinate'])
  assert.deepEqual(derived.travelAtlas.countries.map((country) => country.id), ['iceland'])
  assert.equal(derived.wantToGo.plannedConvertBlockReason(derived.travelAtlas.plannedRecords[2]), '这条旅行计划没有坐标，无法转为足迹。')
  // RFC-LOC-1 Core-A：planned 记录只产出成员关系，实体 id 是记录所在城市的地点 id；与 visited 同城的那条就落在足迹城市上。
  assert.equal(derived.worldGraph.plannedSnapshot.entities.length, 0)
  assert.deepEqual(
    derived.worldGraph.plannedSnapshot.memberships.map((membership) => [membership.entityId, membership.recordId]),
    [['iceland__reykjavik', 'same-city'], ['norway__bergen', 'planned-only'], ['norway__oslo', 'planned-no-coordinate']],
  )
  assert.deepEqual(derived.travelAtlas.cities.map((city) => city.id), ['iceland__reykjavik'])
})

test('按记录 id 的两张表（Core 方案 C3）：键是想去条目与 planned 记录的 id，值是同一个对象；想去图层每条成员关系的 recordId 都查得到', () => {
  const derived = derive('combined')
  const { wantToGoItemById, plannedRecordById, wantToGoItems } = derived.wantToGo
  const { plannedRecords } = derived.travelAtlas
  assert.deepEqual([...wantToGoItemById.keys()], ['wtg_2026-08-12_nuuk', 'wtg_2026-08-12_tromso', 'wtg_2026-08-12_akureyri'])
  for (const item of wantToGoItems) assert.equal(wantToGoItemById.get(item.id), item)
  assert.deepEqual([...plannedRecordById.keys()], ['planned_bergen'])
  for (const record of plannedRecords) assert.equal(plannedRecordById.get(record.id), record)

  const memberships = derived.worldGraph.worldGraphSnapshot.memberships.filter((membership) => membership.layerId === 'want_to_go')
  assert.equal(memberships.length, 4)
  for (const membership of memberships) {
    const recordId = membership.recordId ?? ''
    const found = membership.metadata?.source === PLANNED_SOURCE ? plannedRecordById.get(recordId) : wantToGoItemById.get(recordId)
    assert.ok(found, `${membership.entityId} 的 recordId ${recordId}`)
  }
})

test('「这个城市已经在足迹里了」按地点 id 判断（Core 方案 C5）：同名但是另一个地点不算，同一个地点算', () => {
  const blockedIds = (canonical: CanonicalData) => {
    const { wantToGo } = deriveAppDataFromCanonical(canonical, { now: NOW })
    return wantToGo.wantToGoItems.filter((item) => wantToGo.wantToGoConvertBlockReason(item) !== undefined).map((item) => item.id)
  }
  // 迁移合并后（M）：想去的阿克雷里就是足迹城市阿克雷里这个地点。
  const migrated = migratedCanonical('sample').canonical
  const akureyriPlaceId = migrated.wantToGo.items.find((item) => item.id === 'wtg_2026-08-12_akureyri')?.placeId
  assert.ok(migrated.travel.records.some((record) => record.placeId === akureyriPlaceId && record.status !== 'planned'))
  assert.deepEqual(blockedIds(migrated), ['wtg_2026-08-12_akureyri'])
  // 不合并直接搬进 V2 id 空间：想去的阿克雷里是另一个地点，名字相同也不算（A1 之前按名字算）。
  assert.deepEqual(blockedIds(v2SpaceCanonical('sample')), [])
})

test('媒体：城市照片、封面、无人机、隐藏、悬空引用', () => {
  const derived = derive('media')
  assert.deepEqual(derived.mediaCatalog.getCityPhotos('iceland__reykjavik').map((item) => item.id), ['p3', 'p1'])
  assert.equal(derived.mediaCatalog.getCityCoverPhoto('iceland__reykjavik')?.id, 'p3')
  assert.deepEqual(derived.droneMedia.getDroneMediaForCity('iceland__vik').map((item) => item.id), ['d2', 'd1'])
  // 悬空引用保留：仍在目录与无人机列表里，只是没有国家 id 与名称（城市名回落到 cityId）。
  const ghost = derived.droneMedia.droneMediaById.ghost
  assert.deepEqual([ghost.city, ghost.country], ['atlantis__ghost', undefined])
  assert.deepEqual(derived.mediaCatalog.allImportedMediaItems.map((item) => item.id), ['p1', 'p2', 'p3', 'p4', 'd1', 'd2', 'd3', 'v1', 'ghost'])
})

// ---------------------------------------------------------------------------
// 锁定（RFC-LOC-1 PR5b §4.1）：冻结夹具与公开 V2 样例的派生基线
// ---------------------------------------------------------------------------

/**
 * 派生基线的 sha256：`stableStringify(buildBaseline(deriveAppDataFromCanonical(…)))` 加末尾换行，与 scripts 的基线工具
 * 写出的文件相同。冻结时（PR5b 第一个提交）旧 id 空间的每一份都等于旧路径 B（`deriveAppData(normalizeLegacy(原始数据))`），
 * 公开样例（旧 id）同时等于 PR1 起公布的 @2 基线 8caf2cfb…。RFC-LOC-1 Core-A A1 只给基线做了加法；Core-A A2 改了 World Graph
 * （地点实体 id、按身份合并，见文件开头），下面的值是 A2 之后的。派生代码改变了任何一处结果，这里就会变红。
 */
const baselineSha256 = (canonical: CanonicalData) =>
  sha256(stableStringify(buildBaseline(deriveAppDataFromCanonical(canonical, { now: NOW }), { now: NOW })))

const readJsonFile = (relative: string): unknown => JSON.parse(readFileSync(new URL(relative, import.meta.url), 'utf8'))

/** 五个 V2 文件经 canonicalForInputs（V2 Reader）→ 派生 → 基线，与 App、基线工具的管线相同。 */
const v2FilesSha256 = (v2Files: V2FileInputs, source: 'local' | 'sample' = 'local') =>
  baselineSha256(canonicalForInputs({ v2Files, source }))

const LEGACY_ID_LOCKS: Record<LegacyIdCanonicalName, string> = {
  sample: '9eb8bb0924a1e4058736db67d7a664d58b7b8395ff92beb3127a872165f20422',
  personal: 'c941a07422a3c9fa36e6c8faf2536200a0109a0c99e42ba96593eb47ada578cb',
  personalDanglingMedia: '107a8b7757c99bc51c8b7e4186aa138ff1a0eea89d9abb012edc7251a8f8a97e',
  nameInconsistency: '7d946afebef29a4b7d703f886a3965f7710fc69a964ef204e1f8004891e720bc',
  countryOfCity: '2cb7bf0da69d96c476e1de35c704dc7904529e5b6d41a605a4e570c5de156925',
  alias: 'b92f0281f752039e88d519b8a8110d457bdff854eb8ccf7f00ec7f3adde6eb0b',
  classification1: '56cec5f1c59db336b36de2325cc36bba135f016231f8b4aa7bd9f22c9300c0ca',
  classification2: 'e5e5e357b4b32dd1d50038017d85ff953a47dde93241184d5ea114955cfa9c1b',
  classification3: 'd498c05294c1523143b99ea4455c7fb7a88461c39cae2d78a55b4776589e8305',
  classification4: '3cc244e63dca0eed000c57846f356bdcdffbbe6a119d476b0da63261b0156560',
  classificationConsistent: 'ae19439e6a869f725b47cb25c8a19852d60ef19115b507b35e3cf69d20b903b0',
  journeyRules1: 'ba01c49e26456cf98e8fb65c7660708f0d6a4f173a1e58f5ee23f90485804cac',
  journeyRules2: 'dd77cbf19e1a9a0a134634e1630d71c73e4cff824eccf9870c13ffd327c8116b',
  journeyRules3: 'f38c8213ad85f98c5dd866c9704804444cec77b799ae03c58d4c2b2c71a12250',
  editorHidden: '6ca81ddb3d8d73cdd512b5d6c6f675115f6a1b7343c5ba57e51901d75b5f2f2d',
  addedCountriesConsistent: 'cc01277ce0cea4ce4be0bdb36bd6de331ec945c130c771a5fdf85c5313479f3f',
  addedCountriesShown: '868841ec6e5662a27a8578dc8981e95e7cace5e2054dc4bfaf59f89aaefc5cee',
  addedCountriesHomeHidden: '3e073ff9cff9f7496590b43aff87c84288d4cdf28c09d3bf4bcb0378f71a5f3a',
  planned: 'f3c3806699583c6d58103e38d02646567a5a441c582c004dd166650f047ac728',
  media: '1e2f797286adb58f4b9c7cfbca870bc830cf3a5251df35a775fca7b57a68c24d',
  combined: '6cecdc0339d585506ca1acc337e469bd81d4205c87ac9761c263309e163b2dc8',
  duplicate: 'e380fff3fd77c13269a653640684794725302f57b3739f51b63d2e2822c9a3ee',
  caseAndDiacritic: 'c49182152d5500cbd915d5f7185733a947e392e39b4255f8ef8b48a4073af9e7',
}

/**
 * 同一批中性数据在 V2 id 空间里：不合并直接搬进来的（v2Space）与迁移规划合并之后的 M（migrated）。
 * 迁移后的五个文件与 M 派生出的基线相同。v2Space 与 M 在 RFC-LOC-1 Core-A A1 之前也相同；A1 起「这个城市已经在足迹里了」
 * 按地点 id 判断（Core 方案 C5），A2 起地图也按地点 id 合并（Core 方案 C4）：想去的阿克雷里在 sample 与 personal 的 v2Space 里
 * 是另一个地点（没合并），不再算已在足迹，地图上也不再并进足迹城市；合并后它就是足迹城市本身。nameInconsistency 没有这种条目，
 * 两者仍相同。
 */
const PERSONAL_V2_LOCK = 'ac0a0e94fac3c0127747f600a5ce4854d27846ca4f68376c997c96f313e65d05'
const SAMPLE_MIGRATED_LOCK = '4e054029858a3feae68cfc7168b90d50dbe546781cf5db5090d8f0c19d31d143'
const NAME_INCONSISTENCY_V2_LOCK = '1be2f99e2d56ce7b1c0b78556fd889badba01d38da1195566082ef32363ede64'

const V2_SPACE_LOCKS: Record<(typeof V2_SPACE_CANONICAL_NAMES)[number], string> = {
  sample: 'f35dda198fe444ed3123870390951bbc7bc3d5092ec415491f4004caf85366a9',
  personal: 'f40159f5c5bef8fc4b8f32e1ada0811ef19eb39cc5bb2500b98a3f9872a6107f',
  nameInconsistency: NAME_INCONSISTENCY_V2_LOCK,
  recordCoordinates: '2bbf7cd6c6fdfdcdfac07eceb3211332073e162c1763b37d1949cb7db9c607ee',
  countryOfCity: 'b1d010319687c821794a1b5d670466891287c5d8d8ca501b45052f5c2cde6df6',
}

const MIGRATED_LOCKS: Record<(typeof MIGRATED_CANONICAL_NAMES)[number], string> = {
  sample: SAMPLE_MIGRATED_LOCK,
  personal: PERSONAL_V2_LOCK,
  nameInconsistency: NAME_INCONSISTENCY_V2_LOCK,
}

/** 冻结的五个 V2 文件（相对本文件的路径）。前两份是同一批中性个人数据迁移后的文件，后三份是三个脚本测试的私人根。 */
const V2_FILES_LOCKS: [string, string][] = [
  ['../v2write/fixtures/migrated-files.json', PERSONAL_V2_LOCK],
  ['../../../scripts/fixtures/bak-files-v2.json', 'a6ee47a01cc522e94ec516ebcdba8af189d187b0b2503fb1b88d1f07592c5ee6'],
  ['../../../scripts/fixtures/baseline-v2.json', 'd98815f873b74abe0488da1f913080dd617ce02051667b4d42a1b6334e4182c2'],
  ['../../../scripts/fixtures/editor-store-v2.json', 'c22055655f6019e53b1c491f60f365fce1948dd08e3014390abb09539d142b2b'],
]

/** 公开 V2 样例的派生基线（RFC-LOC-1 PR4 起公布；`node scripts/baseline.mjs --sample` 的输出）。 */
const V2_SAMPLE_BASELINE_SHA256 = '8bce80df6abf01574cf90c3f5184fdcb036f4fe54aff3926ab20d8dc72424b15'

const V2_SAMPLE_FILE_NAMES = { places: 'places.json', travel: 'travel-map.json', wantToGo: 'want-to-go.json', editorState: 'editor-state.json', media: 'user-media.json' }

test('锁定：旧 id 空间的冻结 Canonical（本文件、placeResolver 与 derive/baseline 测试的输入）的派生基线', () => {
  assert.deepEqual(Object.keys(LEGACY_ID_LOCKS), [...LEGACY_ID_CANONICAL_NAMES])
  for (const name of LEGACY_ID_CANONICAL_NAMES) assert.equal(baselineSha256(legacyIdCanonical(name)), LEGACY_ID_LOCKS[name], name)
})

test('锁定：V2 id 空间的冻结 Canonical 与迁移后的 M（v2Reader / v2Schema / v2Serializer 与本文件的输入）的派生基线', () => {
  assert.deepEqual(Object.keys(V2_SPACE_LOCKS), [...V2_SPACE_CANONICAL_NAMES])
  for (const name of V2_SPACE_CANONICAL_NAMES) assert.equal(baselineSha256(v2SpaceCanonical(name)), V2_SPACE_LOCKS[name], name)
  assert.deepEqual(Object.keys(MIGRATED_LOCKS), [...MIGRATED_CANONICAL_NAMES])
  for (const name of MIGRATED_CANONICAL_NAMES) assert.equal(baselineSha256(migratedCanonical(name).canonical), MIGRATED_LOCKS[name], name)
})

test('锁定：冻结的五个 V2 文件（canonicalForInputs、V2 写入与三个脚本测试的输入）经 canonicalForInputs 的派生基线', () => {
  const { files, migrated } = canonicalForInputsFixture()
  assert.equal(v2FilesSha256(files), PERSONAL_V2_LOCK, 'canonical-for-inputs.json 的文件')
  assert.equal(baselineSha256(migrated), PERSONAL_V2_LOCK, 'canonical-for-inputs.json 的 M')
  for (const [relative, lock] of V2_FILES_LOCKS) assert.equal(v2FilesSha256(readJsonFile(relative) as V2FileInputs), lock, relative)
})

test('锁定：公开 V2 样例（src/data/v2-sample/，来源 sample）的派生基线为 8bce80df…', () => {
  const v2Files = Object.fromEntries(Object.entries(V2_SAMPLE_FILE_NAMES).map(([key, name]) => [key, readJsonFile(`../v2-sample/${name}`)]))
  assert.equal(v2FilesSha256(v2Files, 'sample'), V2_SAMPLE_BASELINE_SHA256)
})
