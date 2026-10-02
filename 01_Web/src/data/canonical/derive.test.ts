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

test('Core receives every registry name and original language without precomputing a fallback', () => {
  const canonical = legacyIdCanonical('sample')
  const city = canonical.places.find((place) => place.subtype === 'city')!
  city.names = { 'zh-Hans': '东京', ja: '東京' }
  city.originalLanguage = 'ja'
  const graph = deriveAppDataFromCanonical(canonical, { now: NOW }).worldGraph.worldGraphSnapshot
  const title = graph.entities.find((entity) => entity.id === city.id)!.title
  assert.deepEqual(title, { names: { 'zh-Hans': '东京', ja: '東京' }, originalLanguage: 'ja' })
  title.names.ja = 'changed'
  assert.equal(city.names.ja, '東京')
})

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
  sample: 'aa0b5531ec3a71b329c2c2772144f2d06e04b19aeb1febcecd065d54641f9f42',
  personal: 'beb897637a255dc07310fe384ad98e5a409be34a539789ffcbd6337692ad771c',
  personalDanglingMedia: '70e731b35ca7c58d601cf307299ed342f38fb678eba9776bb2e587ee977be45c',
  nameInconsistency: '5dd3e81b0c2b4a1450261f2eb6346e8427eff46fb81503fdb7c260fcd8e1e372',
  countryOfCity: 'f912716d14c7f80b91182ed8919e6d5c3fd279f3861684dfefb04bd6f2a30aca',
  alias: '8c087bdde747cc69d46cbdb16b1aa478661787a8b00a34f58a038338fc09a3b9',
  classification1: '610b1eaceb5ea2d02c9d343da2c3f9a4a229ea0bdf82d52fec3dc465f3713225',
  classification2: 'be780a7d882f0e9ecad25506da746085c85948128f88255e9be8b2701a8b04aa',
  classification3: '2fc4b098f69676dccd0302eb08881bab00306be7e6e899e19e495229f8103cd5',
  classification4: '4d143761efa888bfa642c97b36802329ce685cf67478e1277388fcd859794e7d',
  classificationConsistent: '333cde0a208508708e4628719794672d930cc8d043b16726d416f15e60ebb2b4',
  journeyRules1: '454a18a59f670dbd38de21f040108908497c28ee74bbb64590a2ecec00808ff0',
  journeyRules2: 'ea03602c3e6b84e312dc15acb09b291f52feb101a459e9789795be244f5c66e5',
  journeyRules3: '7542c5034e47bcecde5ddfc109d1a5218306c582b91c59928bef1030fdc7b57b',
  editorHidden: '212b243b6a4b27aa1d40935348bb790548444b585b82d096536cb4c6510df6f9',
  addedCountriesConsistent: '55609ebce927221ea290acf40659ebea25a87e780fece96d0c7c0321aa5d3acb',
  addedCountriesShown: '11d9c59564d776a46f6a89bdd50b60551d416cd621b8c9a56a9c816fd640d061',
  addedCountriesHomeHidden: 'f21a5738c6034835ecdcebc1091e3ee0eea994dc7c08b5da1e3e563710f3df3c',
  planned: 'dba8ea5025cd0ddb6f376b19f4b54d02ce552648933da2a6c03f8609539cb248',
  media: '7b3c59aa12106c9ecc76a59415f77f2f88ab0d7c7c53fbc74569d2562bc9bf4a',
  combined: '3fc7154522f2b9c2d985cd9ed15be860aece41c7eb2e0b5374ca145027733d8a',
  duplicate: 'd5b29e36ecef6a6ba06a45761c9825884401e64ba025ff1003ee7a6b7f948916',
  caseAndDiacritic: '37ae6f3e77595e4484b716bb00eb64afb9e64a21d0e606a29c9f5085ccd2fbae',
}

/**
 * 同一批中性数据在 V2 id 空间里：不合并直接搬进来的（v2Space）与迁移规划合并之后的 M（migrated）。
 * 迁移后的五个文件与 M 派生出的基线相同。v2Space 与 M 在 RFC-LOC-1 Core-A A1 之前也相同；A1 起「这个城市已经在足迹里了」
 * 按地点 id 判断（Core 方案 C5），A2 起地图也按地点 id 合并（Core 方案 C4）：想去的阿克雷里在 sample 与 personal 的 v2Space 里
 * 是另一个地点（没合并），不再算已在足迹，地图上也不再并进足迹城市；合并后它就是足迹城市本身。nameInconsistency 没有这种条目，
 * 两者仍相同。
 */
const PERSONAL_V2_LOCK = 'bd04a994e6427bda31bc903f3de35990be5587cc36dae072912c6c70c6f35dd1'
const SAMPLE_MIGRATED_LOCK = '5fc4301bcc50573eb36daab0ff79f42c0d5970a61fe2b5991490c81076152ba3'
const NAME_INCONSISTENCY_V2_LOCK = 'ddb647faec3b15ffebf7230a26b33bbfd196cac75deb33d947b4a07f6256eeea'

const V2_SPACE_LOCKS: Record<(typeof V2_SPACE_CANONICAL_NAMES)[number], string> = {
  sample: '52c65876b2f189195e5ff176d81480acb48e604745af1d61e4b2add6d58d3fe9',
  personal: '9bbd86aad1028d543b935c255433759b6fbe69dfdb4ba48aef57f1472e9d121b',
  nameInconsistency: NAME_INCONSISTENCY_V2_LOCK,
  recordCoordinates: '204d60ff84a4e91059d869d869195034c1b9b6c3103ec673a7adc51fc4a2ea34',
  countryOfCity: '4cbe64374266453e74578f546c443b0fee71649ad1bcff16fa91cb1307faaa4e',
}

const MIGRATED_LOCKS: Record<(typeof MIGRATED_CANONICAL_NAMES)[number], string> = {
  sample: SAMPLE_MIGRATED_LOCK,
  personal: PERSONAL_V2_LOCK,
  nameInconsistency: NAME_INCONSISTENCY_V2_LOCK,
}

/** 冻结的五个 V2 文件（相对本文件的路径）。前两份是同一批中性个人数据迁移后的文件，后三份是三个脚本测试的私人根。 */
const V2_FILES_LOCKS: [string, string][] = [
  ['../v2write/fixtures/migrated-files.json', PERSONAL_V2_LOCK],
  ['../../../scripts/fixtures/bak-files-v2.json', 'd6c598158e8e427b70d12543107664f678fce5b27a03a94059f34b5456858e36'],
  ['../../../scripts/fixtures/baseline-v2.json', 'ecaba5cc00770a5a85189f963bc17e04f85ded3d62dd259163f770e15217a7ea'],
  ['../../../scripts/fixtures/editor-store-v2.json', 'f3bda7b228655ff934093fe8c368d30846665d98e6d75bb2fa8d96117d94b6b3'],
]

/** 公开 V2 样例的派生基线（RFC-LOC-1 PR4 起公布；`node scripts/baseline.mjs --sample` 的输出）。 */
const V2_SAMPLE_BASELINE_SHA256 = '9b68b8add56e9e3c7d0340a503dc733ed5de1304ab959ce8bfd130d3d0e6bec0'

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

test('锁定：公开 V2 样例（src/data/v2-sample/，来源 sample）的派生基线为 9b68b8ad…', () => {
  const v2Files = Object.fromEntries(Object.entries(V2_SAMPLE_FILE_NAMES).map(([key, name]) => [key, readJsonFile(`../v2-sample/${name}`)]))
  assert.equal(v2FilesSha256(v2Files, 'sample'), V2_SAMPLE_BASELINE_SHA256)
})
