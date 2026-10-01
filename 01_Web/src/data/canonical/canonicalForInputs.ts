/**
 * App 的 Canonical（RFC-LOC-1 §3.6，PR3b-1 规格 §2.2；PR5a 起只有 V2）：
 *
 *   五个 V2 文件（私人目录 data/v2/，或公开样例 src/data/v2-sample/）──V2 Reader──> Canonical ──> 派生（./derive.ts）
 *
 * `src/data/canonical/` 是 App 层，【不是】 StarMap Core。App（`../appData.ts`）与基线工具
 * （`scripts/baseline.mjs` 的个人模式与 `--sample`）都只调这一个函数，所以两边读同一份文件得到的 Canonical 相同。
 * PR5a 删除了 legacy 分支：App 不再经 Legacy Adapter 读旧格式文件，公开构建也就不再包含它。
 *
 * - 【只】读 `v2Files`。缺的文件按空处理（`emptyV2Files()`）；五个都缺时得到空的 Canonical
 *   （没有地点、记录、想去、媒体，editor-state 为空）。【不】回落到样例（决定 E）。
 *   补齐后的五个文件先过 `validateV2Files`（V2 Reader 的前提），不合法就抛 `V2FilesInvalidError`，不猜。
 * - 来源（RFC-LOC-1 PR4 规格 §2.3）：`source` 默认 `'local'`（私人目录 `data/v2/`）；
 *   公开样例（`src/data/v2-sample/`）传 `'sample'`，足迹与想去的来源都标为 `'sample'`，App 现有的写入门控
 *   （`travelAtlasDataSource` / `wantToGoDataSource`）因此照旧关闭编辑。V2 Reader 本身不变：来源是运行时字段，
 *   在读出之后换上。
 *
 * 约束：Node 24 能直接加载——erasable-only TypeScript，相对 import 带 `.ts`，类型用 `import type`。
 */

import type { CanonicalData } from './types.ts'
import { readV2 } from './v2Reader.ts'
import {
  EDITOR_STATE_SCHEMA_VERSION,
  MEDIA_SCHEMA_VERSION,
  PLACES_SCHEMA_VERSION,
  TRAVEL_SCHEMA_VERSION,
  V2_FILE_KEYS,
  V2_FILE_NAMES,
  WANT_TO_GO_SCHEMA_VERSION,
  validateV2Files,
  type V2FileKey,
  type V2Files,
  type V2SchemaProblem,
} from './v2Schema.ts'

/** `data/v2/` 下五个文件的原始 JSON 值；缺的文件为 undefined（或不出现）。 */
export type V2FileInputs = Partial<Record<V2FileKey, unknown>>

/** V2 文件从哪来：私人目录（默认）或公开样例。决定 Canonical 的 `travel.source` 与 `wantToGo.source`。 */
export type V2Source = 'local' | 'sample'

/** App 的输入：五个 V2 文件（缺的为 undefined）与它们的来源（缺省为 `'local'`）。 */
export interface AppInputs {
  v2Files: V2FileInputs | undefined
  source?: V2Source
}

/**
 * 地点注册表缺失时补上的 `generated_at`。schema 要求非空，V2 Reader 读时丢弃它，所以取一个固定值。
 */
export const EMPTY_PLACES_GENERATED_AT = '1970-01-01T00:00:00.000Z'

/** 五个空的 V2 文件：合法（通过 `validateV2Files`），读出来是空的 Canonical。每次返回新对象。 */
export const emptyV2Files = (): V2Files => ({
  places: { schema_version: PLACES_SCHEMA_VERSION, generated_at: EMPTY_PLACES_GENERATED_AT, places: [] },
  travel: {
    schema_version: TRAVEL_SCHEMA_VERSION,
    display: { homeHiddenCountryIds: [], originCountryIds: [], regionCountryIds: [], regionIncludes: [], navigationHiddenCityIds: [] },
    records: [],
  },
  wantToGo: { schema_version: WANT_TO_GO_SCHEMA_VERSION, items: [] },
  editorState: {
    schemaVersion: EDITOR_STATE_SCHEMA_VERSION,
    addedCountries: [],
    countryOrder: [],
    hiddenCountryIds: [],
    cityOrderByCountry: {},
    hiddenCityIds: [],
    mediaOrderByCity: {},
    hiddenMediaIds: [],
    coverMediaByCity: {},
    droneOrderByCity: {},
    hiddenDroneMediaIds: [],
  },
  media: { schemaVersion: MEDIA_SCHEMA_VERSION, items: [] },
})

/** 缺的文件（undefined 或不出现）换成空文件；在的文件原样（包括不合法的，留给校验报错）。 */
export const completeV2Files = (files: V2FileInputs | undefined): Record<V2FileKey, unknown> => {
  const empty = emptyV2Files()
  return Object.fromEntries(
    V2_FILE_KEYS.map((key) => [key, files?.[key] === undefined ? empty[key] : files[key]]),
  ) as Record<V2FileKey, unknown>
}

/** V2 文件没有通过校验。消息只列文件、JSON 路径与问题，不含字段的值。 */
export class V2FilesInvalidError extends Error {
  readonly problems: V2SchemaProblem[]
  constructor(problems: V2SchemaProblem[]) {
    const lines = problems.slice(0, 20).map((problem) => `  data/v2/${V2_FILE_NAMES[problem.file]} ${problem.path}：${problem.message}`)
    const more = problems.length > lines.length ? [`  ……另有 ${problems.length - lines.length} 处`] : []
    super([`V2 数据文件没有通过校验（${problems.length} 处），不能读取：`, ...lines, ...more].join('\n'))
    this.name = 'V2FilesInvalidError'
    this.problems = problems
  }
}

/** 五个 V2 文件 → Canonical。只读 `inputs.v2Files`；`inputs.source` 缺省为 `'local'`。 */
export function canonicalForInputs(inputs: AppInputs): CanonicalData {
  const files = completeV2Files(inputs.v2Files)
  const problems = validateV2Files(files)
  if (problems.length > 0) throw new V2FilesInvalidError(problems)
  const canonical = readV2(files as unknown as V2Files)
  const source = inputs.source ?? 'local'
  if (source === 'local') return canonical
  return {
    ...canonical,
    travel: { ...canonical.travel, source },
    wantToGo: { ...canonical.wantToGo, source },
  }
}
