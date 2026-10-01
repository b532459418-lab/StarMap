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
const SAMPLE_BASELINE_SHA256 = '094b7e86893b0954461674755bb970afd7bf69ecf33ee4753627ef783c0fd924'
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
 * RFC-LOC-1 Core-A A1（成员关系带记录 id）对基线只做了加法，格式仍是 @2：快照成员关系与想去 Collection 条目上的
 * `recordId`。去掉它们，得到的就是 A1 之前的 @2 基线。
 */
const removeA1Additions = (baseline: BaselineShape): void => {
  for (const name of SNAPSHOT_EXPORT_NAMES) {
    const snapshot = baseline.modules.worldGraph[name] as { memberships: Record<string, unknown>[] }
    for (const membership of snapshot.memberships) delete membership.recordId
  }
  for (const entry of baseline.queries.collection.want_to_go) delete entry.recordId
}

test('基线 @2：去掉 A1 的加法后等于 A1 之前的 8caf2cfb…；再删掉 countryIdOfCity、format 改回 @1，等于 PR1 公布的 @1 哈希', () => {
  const baseline = buildBaseline(derive('sample'), { now: NOW }) as BaselineShape
  assert.equal(baseline.format, 'starmap-legacy-baseline@2')
  assert.equal(sha256(stableStringify(baseline)), SAMPLE_BASELINE_SHA256)
  removeA1Additions(baseline)
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
  sample: '094b7e86893b0954461674755bb970afd7bf69ecf33ee4753627ef783c0fd924',
  personal: '59d28c1ec42747072a5141d86022007ca40620c2bf568b6f5d02e76f1c26517e',
  personalDanglingMedia: 'a7e8bf02c5402e1a7c911108b93e6e5e99ed7af3920c274c45550561a99cb2de',
  nameInconsistency: '596ec87d2148602f68fcfe2098d2d957e0e69135a53defb122ef2f9a92c400b8',
  countryOfCity: 'd72807699b7649075c3154a05d9495ba17c33029fcc62dc8e2289bd76eccfb34',
  alias: '4a190fc07dd6bf45639a2357869fa03ec19f1af21df3a8ed2eb8d747d05f6350',
  classification1: 'b1c2fd0a4c8d2a78716ddb9a82dbb950dd3bfba5a85053e451e70e47555131e9',
  classification2: '686f28fc21ba095c437be5fce32fc93712f8beabfcb73fea8c3eb2ab4f381e0b',
  classification3: '828e78e084264eae7b78430779e8d4353bb1df7ccb402e8c10dbb764ef112f28',
  classification4: '2f2dfd4ff3d920587a1de746cd5a2d814784c7cd76bdd0582bd0e4966f9fc5c7',
  classificationConsistent: 'a4360307440b41d4a714bba0d5a02ca22727e8590980dd4f4d5a187c20dd64e3',
  journeyRules1: 'e8f45fba6775c19f7345ddc372e0e82c26497b72390bc59bfd7090b8d2eb4393',
  journeyRules2: 'c3722e63f042921fc1605f1794f766c6bc9569d379c1b004e170bea5a9d4e83c',
  journeyRules3: 'ea67ad06a39a91e390dfc17e345dd25cd1396b6a8add86730a137a0f36b711f7',
  editorHidden: 'eceb333045fdb9afb62127be28145f2281b0acae3696d203a3271f5f4959cafd',
  addedCountriesConsistent: '23ae8ba6c3dcbb0d3bffe547c8880d3b0f70f11202b21ff4982045e3eb2147e5',
  addedCountriesShown: 'aa4de009730b969c85e6208356651a7a19524209c7846079f0b2048ab92a4032',
  addedCountriesHomeHidden: '91172e94e507b4cc016d5e84072686bd42dc28742ef5d48578e85d5fd8e061a4',
  planned: '733e440888d9463420216e3631e80c8f542f836b3f96d03ded318f6d0837795d',
  media: '456dd907354888a56cdbdbc9acae8cc89520e7b2b9d7427d2bcc074343aba80b',
  combined: '8a2cea0ae26c010a6bfb95331fb616e31e3ca008319d4dbaf1887e236c868616',
  duplicate: '9a495edbf261aaf423a4fb27078501079051232df5e2204fd99b5de6fd7267fb',
  caseAndDiacritic: '58694185c4354dedb131629d52730dba0a131994c2bf8d2f92ef287bb57912ba',
}

/**
 * 同一批中性数据在 V2 id 空间里：不合并直接搬进来的（v2Space）与迁移规划合并之后的 M（migrated）。
 * 两者、以及迁移后的五个文件派生出的基线相同（这批数据的合并不改变任何显示结果）。
 */
const PERSONAL_V2_LOCK = 'bfba719d326dc8222383491af8c169df99baff0b70cc07aa8a3b09622d2e83b4'
const SAMPLE_V2_SPACE_LOCK = '737fb0133a3eb7c3e037a48b97ff0ef5cc9a479f8540ea919caa3ddf8349e762'
const NAME_INCONSISTENCY_V2_LOCK = '1884a1535046802bc4479c265841f7d2f8daf504b740fe8b6e5ce395533543f8'

const V2_SPACE_LOCKS: Record<(typeof V2_SPACE_CANONICAL_NAMES)[number], string> = {
  sample: SAMPLE_V2_SPACE_LOCK,
  personal: PERSONAL_V2_LOCK,
  nameInconsistency: NAME_INCONSISTENCY_V2_LOCK,
  recordCoordinates: '519d94b7dfee2bcbabe4fb9657aa2a76ddfc36af57095f61f4307f8b35b6c6c7',
  countryOfCity: 'c2637a91eb57e26b8c4646e9fbede2c68b1144e2843c325df2ac24cf3a177144',
}

const MIGRATED_LOCKS: Record<(typeof MIGRATED_CANONICAL_NAMES)[number], string> = {
  sample: SAMPLE_V2_SPACE_LOCK,
  personal: PERSONAL_V2_LOCK,
  nameInconsistency: NAME_INCONSISTENCY_V2_LOCK,
}

/** 冻结的五个 V2 文件（相对本文件的路径）。前两份是同一批中性个人数据迁移后的文件，后三份是三个脚本测试的私人根。 */
const V2_FILES_LOCKS: [string, string][] = [
  ['../v2write/fixtures/migrated-files.json', PERSONAL_V2_LOCK],
  ['../../../scripts/fixtures/bak-files-v2.json', '508f661afda27ada26046f8be8b9feb0bc239bf57de29c7849643eace886333c'],
  ['../../../scripts/fixtures/baseline-v2.json', '6d98fee09caee25348ac0c6aac33e13f4333f2b66556a03527f045cc400e52e3'],
  ['../../../scripts/fixtures/editor-store-v2.json', 'ea49b4da2b0ab15322eb4a421a96093e7b9eace5def711cb2fde2d9b9b6be4bc'],
]

/** 公开 V2 样例的派生基线（RFC-LOC-1 PR4 起公布；`node scripts/baseline.mjs --sample` 的输出）。 */
const V2_SAMPLE_BASELINE_SHA256 = '77cd872b905b2053c70d1d9d4cae6f038df2d7d108f06a65c68c36b04bd90496'

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

test('锁定：公开 V2 样例（src/data/v2-sample/，来源 sample）的派生基线为 77cd872b…', () => {
  const v2Files = Object.fromEntries(Object.entries(V2_SAMPLE_FILE_NAMES).map(([key, name]) => [key, readJsonFile(`../v2-sample/${name}`)]))
  assert.equal(v2FilesSha256(v2Files, 'sample'), V2_SAMPLE_BASELINE_SHA256)
})
