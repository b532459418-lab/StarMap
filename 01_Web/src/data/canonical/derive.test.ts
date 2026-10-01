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
import { buildBaseline, stableStringify } from '../derive/baseline.ts'
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
 * 公开样例（旧 id 空间）的基线：今天的 @2、Core-A A1 之前的 @2（PR3b-1 增加 countryIdOfCity，PR1 起公布）与 @1。
 */
const SAMPLE_BASELINE_SHA256 = '2e34a237997790e39eec48e33fe02605794a390c564316ac1ebd894ff1948a41'
const SAMPLE_BASELINE_SHA256_BEFORE_A1 = '8caf2cfb4e0a4c3180aa004e0f65c919f9dcca4424e6bb0445943175fe38ac34'
const SAMPLE_BASELINE_SHA256_V1 = 'eb91f172531f7c87280b07399af6ee80d1fc6e99a2ad38efa50b60b9afd299a4'

/** 基线 JSON 里与下面几项改动有关的部分（buildBaseline 返回 unknown）。 */
interface BaselineShape {
  format: string
  modules: { travelAtlas: Record<string, unknown>; wantToGo: Record<string, unknown>; worldGraph: Record<string, unknown> }
  queries: { collection: Record<string, Record<string, unknown>[]> }
}

const SNAPSHOT_EXPORT_NAMES = ['travelSnapshot', 'wantToGoSnapshot', 'plannedSnapshot', 'worldGraphSnapshot'] as const

/**
 * RFC-LOC-1 Core-A A1（成员关系带记录 id）对基线做的加法，格式仍是 @2：快照成员关系与想去 Collection 条目上的
 * `recordId`，以及想去模块按记录 id 的两张表 `wantToGoItemById` / `plannedRecordById`。
 */
const removeA1Additions = (baseline: BaselineShape): void => {
  for (const name of SNAPSHOT_EXPORT_NAMES) {
    const snapshot = baseline.modules.worldGraph[name] as { memberships: Record<string, unknown>[] }
    for (const membership of snapshot.memberships) delete membership.recordId
  }
  for (const entry of baseline.queries.collection.want_to_go) delete entry.recordId
  delete baseline.modules.wantToGo.wantToGoItemById
  delete baseline.modules.wantToGo.plannedRecordById
}

const IN_FOOTPRINT_REASON = '这个城市已经在足迹里了。如果只是想从想去列表移除，请使用隐藏或彻底删除。'

test('基线 @2：去掉 A1 的加法、还原 A1 的唯一差异后等于 A1 之前的 8caf2cfb…；再删掉 countryIdOfCity、format 改回 @1，等于 PR1 公布的 @1 哈希', () => {
  const baseline = buildBaseline(derive('sample'), { now: NOW }) as BaselineShape
  assert.equal(baseline.format, 'starmap-legacy-baseline@2')
  assert.equal(sha256(stableStringify(baseline)), SAMPLE_BASELINE_SHA256)
  removeA1Additions(baseline)

  // A1 唯一的非加法差异（Core 方案 C5）：「已在足迹」改为按地点 id 判断。这份旧 id 空间的数据里，想去的阿克雷里
  // 是自己的地点（wtg:…），不是足迹城市 iceland__akureyri，所以不再算已在足迹；A1 之前按「国家代码 + 英文名」算。
  const reasons = baseline.modules.wantToGo.wantToGoConvertBlockReason as [string, string | null][]
  const akureyri = reasons.find(([id]) => id === 'wtg_2026-08-12_akureyri')
  assert.deepEqual(akureyri, ['wtg_2026-08-12_akureyri', null])
  akureyri![1] = IN_FOOTPRINT_REASON
  assert.equal(sha256(stableStringify(baseline)), SAMPLE_BASELINE_SHA256_BEFORE_A1)
  assert.deepEqual(baseline.modules.travelAtlas.countryIdOfCity, [
    ['iceland__reykjavik', 'iceland'],
    ['iceland__vik', 'iceland'],
    ['iceland__akureyri', 'iceland'],
    ['faroe-islands__torshavn', 'faroe-islands'],
    ['faroe-islands__gjogv', 'faroe-islands'],
  ])

  delete baseline.modules.travelAtlas.countryIdOfCity
  baseline.format = 'starmap-legacy-baseline@1'
  assert.equal(sha256(stableStringify(baseline)), SAMPLE_BASELINE_SHA256_V1)
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
  assert.equal(derived.worldGraph.plannedSnapshot.entities.length, 3)
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
 * 公开样例（旧 id）同时等于 PR1 起公布的 @2 基线 8caf2cfb…。RFC-LOC-1 Core-A A1 只给基线做了加法（见文件开头的
 * removeA1Additions），下面的值是 A1 之后的。派生代码改变了任何一处结果，这里就会变红。
 */
const baselineSha256 = (canonical: CanonicalData) =>
  sha256(stableStringify(buildBaseline(deriveAppDataFromCanonical(canonical, { now: NOW }), { now: NOW })))

const readJsonFile = (relative: string): unknown => JSON.parse(readFileSync(new URL(relative, import.meta.url), 'utf8'))

/** 五个 V2 文件经 canonicalForInputs（V2 Reader）→ 派生 → 基线，与 App、基线工具的管线相同。 */
const v2FilesSha256 = (v2Files: V2FileInputs, source: 'local' | 'sample' = 'local') =>
  baselineSha256(canonicalForInputs({ v2Files, source }))

const LEGACY_ID_LOCKS: Record<LegacyIdCanonicalName, string> = {
  sample: '2e34a237997790e39eec48e33fe02605794a390c564316ac1ebd894ff1948a41',
  personal: '85c1b57a421b7daafc79f09b571e902c322fa3eadcd1b86a86228b43e727e8d5',
  personalDanglingMedia: '06dee44bd4320111750277eb301b7c635964ccf30926ecd153b423fcbddde6e2',
  nameInconsistency: '7edb6e7a91bcd275ab7d2a4d0784f52bf2004667ada897d0f03730710d7581a4',
  countryOfCity: '63f31e2fd88db1c6b1ac5620e172b136fe2b98c14081aa07c81ab91c2fa0ec41',
  alias: '1905f58f011ad74bb8778cd4bab74b1e312a8617bb016575af8b67e848a23628',
  classification1: '6d0979e103ea89a8aca040130f14c5fb0d9b12b34732a8fb6327e79778b334e4',
  classification2: 'ea3f5b6f136dc0f3cacd6fad2d2a8ad56b2ad5bc11713665e04bd7ff36f8a75c',
  classification3: '7107df5db955effa33fb4c219c09c5dbb70afc961c336a4e83f06a16a68ec175',
  classification4: '1db92319f01f6680958a317a8875f4a2ae2954f68a00acf1897d77cafb75f19a',
  classificationConsistent: 'deb6b695ddc133b2db7a95850c0bf94f513860e3ee08858717a0686687c06191',
  journeyRules1: '99d94746d993b7c50c265f6937d7c62149077579e4fc868d8c68470f4b0f91df',
  journeyRules2: '26e92b04d6aa4246c6be8c5e2410ef8492de4f974b3139e70879e3d38673f5fb',
  journeyRules3: 'db096e68069a62dd86f0a0eaf9f32d02a2fa0d9a671308cdd657a42e0ff77194',
  editorHidden: '0583907689bc7fb856ae5e9aeb3ddbc611dd904bb5a327e44d65580bdceea499',
  addedCountriesConsistent: 'e43af56d9efef4acc0988df6afd735171e3d417b1fd8e6db7a7ccfd32e23cb06',
  addedCountriesShown: '0349e4229b4aaa59f99149c8c7aa51d96b8aab8d672740e9b3452c8011f49f54',
  addedCountriesHomeHidden: '092883715d0af4eec2fb0ad3d925e389e9e83f5f73d3b4796eec3cfec26804e1',
  planned: '6698928970fbaa5037802a10adf53430b7b481709480f3781f5f458879c80a30',
  media: '974d197a4e5bc8288c5dd70b6cb14ac2e443f192f67bfc0f2774744aa440cf89',
  combined: '5dca293a21bdef2eae10d35730ede4905fb27515bb7df77db366b1875d2d36d1',
  duplicate: '7882d51e34ee98661265184e69b2931f3e6074b682c22cce9a5a229c9635c43b',
  caseAndDiacritic: '1d869e97edd7486859a668126ba27b45ac42bcd74e269cb5344c62b803fef1ba',
}

/**
 * 同一批中性数据在 V2 id 空间里：不合并直接搬进来的（v2Space）与迁移规划合并之后的 M（migrated）。
 * 迁移后的五个文件与 M 派生出的基线相同。v2Space 与 M 在 RFC-LOC-1 Core-A A1 之前也相同；A1 起「这个城市已经在足迹里了」
 * 按地点 id 判断（Core 方案 C5），sample 与 personal 的 v2Space 各差一处：想去的阿克雷里在 v2Space 里是另一个地点
 * （没合并），不再算已在足迹；合并后它就是足迹城市本身，仍算。nameInconsistency 没有这种条目，两者仍相同。
 */
const PERSONAL_V2_LOCK = '9431fbb661c6807258a44fd2ca666059bedaec466d07502ef81cc6ef6db10c4e'
const SAMPLE_MIGRATED_LOCK = '28580c5f96b0ea166bf4309ae97ad4eb19d92342fdbe1d34655f78385380458e'
const NAME_INCONSISTENCY_V2_LOCK = '9eca871e84a60bc7d1c31ed24a965c6e4587ebd181545b0c6c3ada8b71fc424e'

const V2_SPACE_LOCKS: Record<(typeof V2_SPACE_CANONICAL_NAMES)[number], string> = {
  sample: 'aa6321858035ee3ca7bf16f8c7d9db3af0394efdf8699f0e409d86d0955d4f90',
  personal: '770c6307ddb047188aa19d5f674ac1d107d5162137f704c9200de9a1ff53b4ae',
  nameInconsistency: NAME_INCONSISTENCY_V2_LOCK,
  recordCoordinates: '92eedeb3355a58e0000dce22c4aee011af09fb772fb687c8dcf64649208d51d3',
  countryOfCity: '4cd8dce60d5ae4a97c6ae3718557c48962b8748ced56f71757d1b1035fa962c0',
}

const MIGRATED_LOCKS: Record<(typeof MIGRATED_CANONICAL_NAMES)[number], string> = {
  sample: SAMPLE_MIGRATED_LOCK,
  personal: PERSONAL_V2_LOCK,
  nameInconsistency: NAME_INCONSISTENCY_V2_LOCK,
}

/** 冻结的五个 V2 文件（相对本文件的路径）。前两份是同一批中性个人数据迁移后的文件，后三份是三个脚本测试的私人根。 */
const V2_FILES_LOCKS: [string, string][] = [
  ['../v2write/fixtures/migrated-files.json', PERSONAL_V2_LOCK],
  ['../../../scripts/fixtures/bak-files-v2.json', 'eb8dc06b85f7ba48ad324b457c7ae63acd3f381eb11a3dddc4a50b2569e71185'],
  ['../../../scripts/fixtures/baseline-v2.json', '87a26c86ff165cc8752923cdb9405fa4f16eadabd6b64cc941df69802bdbc0a5'],
  ['../../../scripts/fixtures/editor-store-v2.json', '46669f394ba1ac80a84dc150a75754b6a4a35255c7e5e0f6a2643d537c8108d6'],
]

/** 公开 V2 样例的派生基线（RFC-LOC-1 PR4 起公布；`node scripts/baseline.mjs --sample` 的输出）。 */
const V2_SAMPLE_BASELINE_SHA256 = '5cd7bf55f6b9fa61774c0f7f22d1a2db3a5eb845b6757abd13cd32dc0a6a9756'

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

test('锁定：公开 V2 样例（src/data/v2-sample/，来源 sample）的派生基线为 5cd7bf55…', () => {
  const v2Files = Object.fromEntries(Object.entries(V2_SAMPLE_FILE_NAMES).map(([key, name]) => [key, readJsonFile(`../v2-sample/${name}`)]))
  assert.equal(v2FilesSha256(v2Files, 'sample'), V2_SAMPLE_BASELINE_SHA256)
})
