/**
 * 派生基线的哈希锁（第 3C-5A 批从 ./derive.test.ts 原样移出，值一个都没改）：derive.test.ts 用它锁定 Canonical 路径，
 * ../store/readModelLocks.test.ts 与 ../sample/sample.test.ts 用同一把锁检查「迁移 → 读模型 → 官方视图」路径。
 * 锁的含义与历次变更的说明见 derive.test.ts 中「派生基线的 sha256」一段。不是测试文件，App 代码从不 import 它。
 *
 * `V2_FILES_LOCKS` 的路径相对于本文件（与 derive.test.ts 同一目录）；`lockedFixtureUrl` 把它解析成 URL。
 *
 * 约束：Node 24 能直接加载——erasable-only TypeScript，相对 import 带 `.ts`，类型用 `import type`。
 */

import type { LegacyIdCanonicalName, MIGRATED_CANONICAL_NAMES, V2_SPACE_CANONICAL_NAMES } from './frozen.fixture.ts'

/** `V2_FILES_LOCKS` 中的相对路径 → URL（相对于本文件）。 */
export const lockedFixtureUrl = (relative: string): URL => new URL(relative, import.meta.url)

export const LEGACY_ID_LOCKS: Record<LegacyIdCanonicalName, string> = {
  sample: 'aa0b5531ec3a71b329c2c2772144f2d06e04b19aeb1febcecd065d54641f9f42',
  personal: '6896435e27118a5235460c2d9efcef8258eb8016fbf55132f080e57d64595858',
  personalDanglingMedia: '73c281eddaeb874ad91adf71cabeb8973a831d463df8e272ee3cd35ce8c571ee',
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
  combined: '27ea0ae52bd795825d901b79f77ecc5db642be5d5cf10c340a619cab5753eaa4',
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
export const PERSONAL_V2_LOCK = 'e9d57c16a879c7280349ce984d3e6846cee94a48e9e08c6015a75f6fd24adc6e'
export const SAMPLE_MIGRATED_LOCK = '5fc4301bcc50573eb36daab0ff79f42c0d5970a61fe2b5991490c81076152ba3'
export const NAME_INCONSISTENCY_V2_LOCK = 'ddb647faec3b15ffebf7230a26b33bbfd196cac75deb33d947b4a07f6256eeea'

export const V2_SPACE_LOCKS: Record<(typeof V2_SPACE_CANONICAL_NAMES)[number], string> = {
  sample: '52c65876b2f189195e5ff176d81480acb48e604745af1d61e4b2add6d58d3fe9',
  personal: 'a13b9729a34a16f6cb39055eb5b02fcb88e5107c790864c85fced35e6082bb0d',
  nameInconsistency: NAME_INCONSISTENCY_V2_LOCK,
  recordCoordinates: '204d60ff84a4e91059d869d869195034c1b9b6c3103ec673a7adc51fc4a2ea34',
  countryOfCity: '4cbe64374266453e74578f546c443b0fee71649ad1bcff16fa91cb1307faaa4e',
}

export const MIGRATED_LOCKS: Record<(typeof MIGRATED_CANONICAL_NAMES)[number], string> = {
  sample: SAMPLE_MIGRATED_LOCK,
  personal: PERSONAL_V2_LOCK,
  nameInconsistency: NAME_INCONSISTENCY_V2_LOCK,
}

/** 冻结的五个 V2 文件（相对本文件的路径）。前两份是同一批中性个人数据迁移后的文件，后三份是三个脚本测试的私人根。 */
export const V2_FILES_LOCKS: [string, string][] = [
  ['../editor/fixtures/migrated-files.json', PERSONAL_V2_LOCK],
  ['../../../scripts/fixtures/bak-files-v2.json', 'd6c598158e8e427b70d12543107664f678fce5b27a03a94059f34b5456858e36'],
  ['../../../scripts/fixtures/baseline-v2.json', 'ecaba5cc00770a5a85189f963bc17e04f85ded3d62dd259163f770e15217a7ea'],
  ['../../../scripts/fixtures/editor-store-v2.json', 'ea18048301cdab27de440776265de4f4aff0a83e13bcce2d6172d03d89195025'],
]

/** 公开 V2 样例的派生基线（RFC-LOC-1 PR4 起公布；`node scripts/baseline.mjs --sample` 的输出）。 */
export const V2_SAMPLE_BASELINE_SHA256 = '9b68b8add56e9e3c7d0340a503dc733ed5de1304ab959ce8bfd130d3d0e6bec0'
