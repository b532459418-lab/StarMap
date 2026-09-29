/**
 * 身份迁移工具（RFC-LOC-1 §3.5–§3.6，PR3a 规格 §3）：旧格式的私人数据 → V2 文件。
 *
 *   node scripts/migrate-identity.mjs --sample [--out-dir <dir>] [--apply] [--now <ISO 时间>]   公开样例；清单与决定只在内存里，除非另给路径
 *   node scripts/migrate-identity.mjs [--apply [--switch]]                                     私人目录
 *     --manifest <path>    默认：私人目录 data/migration/identity-manifest.local.json
 *     --decisions <path>   默认：私人目录 data/migration/identity-decisions.local.json
 *     --out-dir <dir>      默认：私人目录 data/v2/（--sample 时 --apply 必须给出）
 *     --report <path>      把完整报告写成 JSON
 *     --details            摘要里列出记录 id 与地点旧 id
 *     --switch             （RFC-LOC-1 PR4）只与 --apply 同用、只用于私人目录、输出目录只能是默认的 data/v2/：
 *                          V2 文件写出并校验通过后，原子写入数据模式标记 `{ "mode": "v2" }`（scripts/data-mode.mjs 的
 *                          writeDataModeMarker，不带 BOM），并打印如何回滚（`npm run data-mode -- legacy`）
 *     --now <ISO 时间>     （RFC-LOC-1 PR4）只与 --sample 同用：固定规划时间（地点注册表的 generated_at、清单的 plannedAt），
 *                          让 `npm run sample:v2` 的输出逐字节可复现。必须是 `2026-08-12T00:00:00.000Z` 这样的 UTC 时间
 *
 * 规划本身是纯函数 `planMigration`（src/data/migration/planMigration.ts）；本脚本只负责读文件、
 * 算旧文件的哈希、打印摘要、按门槛写文件。
 *
 * - 私人模式只读私人文件，【不】回落到样例：四个旧文件都不存在 → 无需迁移（退出码 0）；只缺几个 → 按空处理
 *   （足迹为 `{ schema_version: 1, records: [] }`，想去为没有文件）。「无需迁移」在隐私门之后、数据模式检查之前判断
 *   （PR4 规格 §2.2，PR3b-1 发现 5）：PR4 起全新私人目录默认就是 V2，在上面跑迁移应当得到「无需迁移」，而不是被拒。
 * - dry-run（默认）：打印中文摘要。私人模式写回迁移清单（记录本次旧文件的哈希）；`--sample` 默认不写任何文件，
 *   给了 `--manifest` 才读写那个文件。
 * - `--apply`：canApply、迁移清单记录的哈希等于当前旧文件的哈希（`--sample` 且没给 `--manifest` 时清单只在内存里，
 *   不检查）、输出目录不存在或为空、输出目录在私人根目录之内或本仓库之外——全部满足才写出五个 V2 文件（各自原子写入），
 *   否则拒绝（退出码 2）。新分配了 UUID 时同时写回迁移清单。不给 `--switch` 时不写数据模式标记文件；任何情况下都不动旧文件。
 *   「为空」不算 `--manifest` 指向的那个文件本身（RFC-LOC-1 PR4）：公开样例把固定的迁移清单放在输出目录里
 *   （src/data/v2-sample/identity-manifest.json），重新生成时只删五个 V2 文件、保留清单。
 *   私人模式下数据模式（scripts/data-mode.mjs）已经是 v2 时，`--apply` 直接拒绝（退出码 2，RFC-LOC-1 PR3b-1）：
 *   data/v2/ 是正在使用的数据；标记文件不合法时报错（退出码 1）。dry-run 不受影响。
 * - `--sample` 的输出（RFC-LOC-1 PR4 规格 §2.3）：文件名不带 `.local`（places.json、travel-map.json……，见 scripts/v2-sample.mjs），
 *   因为那是公开样例而不是私人数据；隐私门在 `--sample` 下额外放行 `src/data/v2-sample/` 这一个目录（不含子目录），
 *   仓库里的其他位置照旧拒绝。生成命令是 `npm run sample:v2`。
 * - 隐私门（与 legacy-baseline.mjs 共用 private-output.mjs 的判断）：私人模式下 `--report` 与 `--out-dir`
 *   只能在私人根目录之内（即使私人根在仓库里，例如独立克隆的 06_private/）或仓库之外（退出码 2），
 *   在读取任何私人文件之前检查。`--apply` 的输出目录用同一个判断。摘要只打印计数、键、id 与 JSON 路径，不打印名称与坐标；名称写在 `--report` 里。
 *   读取失败只报路径与类别，不打印文件内容。
 *
 * 退出码：dry-run 完成为 0（即使 canApply 为 false）；参数或读取错误为 1；`--apply` 被拒与隐私门为 2。
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

import {
  assertDataModeMarkerWritable,
  DataModeMarkerError,
  DataModeMarkerWriteRefused,
  hasLegacyData,
  resolveDataMode,
  writeDataModeMarker,
} from './data-mode.mjs'
import { atomicJsonWrite } from './json-file.mjs'
import { canonicalPath, isAllowedPrivateOutput } from './private-output.mjs'
import { getPrivatePaths, sourceRoot, webRoot } from './private-profile.mjs'
import { isV2SampleDirectory, V2_SAMPLE_FILE_NAMES } from './v2-sample.mjs'
import { uuidv7 } from '../src/data/canonical/uuidv7.ts'
import { V2_FILE_KEYS, V2_FILE_NAMES, validateV2Files } from '../src/data/canonical/v2Schema.ts'
import { isTravelMapExport } from '../src/data/derive/travelAtlas.ts'
import { IdentityFileError, parseIdentityDecisions, parseIdentityManifest } from '../src/data/migration/identityFiles.ts'
import { fileMetaFromRaw, planMigration } from '../src/data/migration/planMigration.ts'

const usage = [
  '用法：',
  '  node scripts/migrate-identity.mjs --sample [--out-dir <dir>] [--apply] [--now <ISO 时间>] [--manifest <path>] [--decisions <path>] [--report <path>] [--details]',
  '  node scripts/migrate-identity.mjs [--apply [--switch]] [--manifest <path>] [--decisions <path>] [--out-dir <dir>] [--report <path>] [--details]',
].join('\n')

class UsageError extends Error {}
class PrivacyGateError extends Error {}
class ReadError extends Error {}
class DataModeRefusal extends Error {}

/** `--now` 只接受 `Date#toISOString()` 的写法（UTC、毫秒、Z），这样写进文件的值就是给出的原文。 */
const isIsoTimestamp = (value) => {
  const time = Date.parse(value)
  return !Number.isNaN(time) && new Date(time).toISOString() === value
}

const parseArgs = (argv) => {
  const options = { sample: false, apply: false, details: false, switch: false }
  const valueAfter = (index, flag) => {
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) throw new UsageError(`${flag} 后面需要一个${flag === '--now' ? '时间' : '路径'}。`)
    return value
  }
  const flags = { '--sample': 'sample', '--apply': 'apply', '--details': 'details', '--switch': 'switch' }
  const values = { '--manifest': 'manifest', '--decisions': 'decisions', '--out-dir': 'outDir', '--report': 'report', '--now': 'now' }
  const seen = new Set()
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (seen.has(arg)) throw new UsageError(`参数重复：${arg}`)
    seen.add(arg)
    if (flags[arg]) {
      options[flags[arg]] = true
    } else if (values[arg]) {
      options[values[arg]] = valueAfter(index, arg)
      index += 1
    } else {
      throw new UsageError(`无法识别的参数：${arg}`)
    }
  }
  if (options.sample && options.apply && options.outDir === undefined) {
    throw new UsageError('--sample --apply 必须用 --out-dir 指定输出目录。')
  }
  // RFC-LOC-1 PR4 规格 §2.2：--switch 只用于私人目录的 --apply；--now 只用于 --sample。
  if (options.switch && options.sample) throw new UsageError('--sample 不接受 --switch：公开样例不写数据模式标记。')
  if (options.switch && !options.apply) throw new UsageError('--switch 只能与 --apply 同用。')
  if (options.now !== undefined && !options.sample) throw new UsageError('--now 只能与 --sample 同用（用于固定公开样例的 generated_at）。')
  if (options.now !== undefined && !isIsoTimestamp(options.now)) {
    throw new UsageError('--now 必须是 UTC 的 ISO 8601 时间，写法同 Date#toISOString()，例如 2026-08-12T00:00:00.000Z。')
  }
  return options
}

// ---- 读取 ----

/** 读取失败只报路径与类别：JSON.parse 的错误消息会带出文件原文片段，私人文件不能这样泄露。 */
const describeReadFailure = (error) => {
  if (error instanceof SyntaxError) return '不是有效的 JSON'
  return error?.code ?? error?.name ?? '未知错误'
}

/** 读一个 JSON 文件：不存在为 `{ exists: false }`；原文字节留着算哈希。 */
const readJsonFile = async (filePath) => {
  let bytes
  try {
    bytes = await readFile(filePath)
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false }
    throw new ReadError(`读取失败：${filePath}（${describeReadFailure(error)}）`)
  }
  try {
    return { exists: true, bytes, value: JSON.parse(bytes.toString('utf8')) }
  } catch (error) {
    throw new ReadError(`读取失败：${filePath}（${describeReadFailure(error)}）`)
  }
}

const sha256 = (content) => createHash('sha256').update(content).digest('hex')

/** 四个旧文件原文的 sha256：按固定顺序拼「文件名 + 原文哈希（不存在为 -）」再取哈希。 */
const sourceHashOf = (files) =>
  sha256(files.map(({ label, file }) => `${label}\n${file.exists ? sha256(file.bytes) : '-'}\n`).join(''))

const SOURCE_LABELS = ['travel-map', 'want-to-go', 'editor-state', 'user-media']

const loadSample = async () => {
  const read = async (name) => {
    const file = await readJsonFile(path.join(webRoot, 'src', 'data', name))
    if (!file.exists) throw new ReadError(`读取失败：${name}（ENOENT）`)
    return file
  }
  const travel = await read('travel-map.sample.json')
  const wantToGo = await read('want-to-go.sample.json')
  const files = [travel, wantToGo, { exists: false }, { exists: false }]
  return {
    raw: {
      travelMap: travel.value,
      travelAtlasDataSource: 'sample',
      editorState: undefined,
      mediaCatalog: undefined,
      wantToGo: { source: 'sample', value: wantToGo.value },
      now: '',
    },
    sourceHash: sourceHashOf(files.map((file, index) => ({ label: SOURCE_LABELS[index], file }))),
  }
}

const loadPrivate = async (paths) => {
  const locations = [paths.localTravelMapPath, paths.wantToGoPath, paths.editorStatePath, paths.mediaCatalogPath]
  const files = []
  for (const location of locations) files.push(await readJsonFile(location))
  if (files.every((file) => !file.exists)) return undefined
  const [travel, wantToGo, editorState, media] = files

  if (travel.exists && !isTravelMapExport(travel.value)) {
    throw new ReadError(`读取失败：${paths.localTravelMapPath}（不是可识别的足迹文件：没有 records 数组）`)
  }
  const hasWantToGo = wantToGo.exists && wantToGo.value !== null
  return {
    raw: {
      travelMap: travel.exists ? travel.value : { schema_version: 1, records: [] },
      travelAtlasDataSource: 'local',
      editorState: editorState.exists ? editorState.value : undefined,
      mediaCatalog: media.exists ? media.value : undefined,
      wantToGo: hasWantToGo ? { source: 'local', value: wantToGo.value } : { source: 'none', value: undefined },
      now: '',
    },
    sourceHash: sourceHashOf(files.map((file, index) => ({ label: SOURCE_LABELS[index], file }))),
  }
}

/** 读迁移清单 / 决定文件；解析失败按读取错误处理（不打印内容）。 */
const readIdentityFile = async (filePath, parse, { required }) => {
  const file = await readJsonFile(filePath)
  if (!file.exists) {
    if (required) throw new ReadError(`读取失败：${filePath}（ENOENT）`)
    return undefined
  }
  try {
    return parse(file.value)
  } catch (error) {
    if (error instanceof IdentityFileError) throw new ReadError(`读取失败：${filePath}（${error.message}）`)
    throw error
  }
}

// ---- 摘要 ----

const COUNT_LABELS = [
  ['places', '地点'],
  ['countries', '国家'],
  ['cities', '城市'],
  ['footprintCountries', '足迹国家'],
  ['footprintCities', '足迹城市'],
  ['records', '足迹记录'],
  ['wantToGoItems', '想去条目'],
  ['mediaItems', '媒体项'],
]

const DECISION_TABLES = { duplicate: 'duplicates', nameDifference: 'nameDifferences', coordinateDifference: 'coordinateDifferences' }

const REASON_LABELS = { sameNameZh: '中文名相同', within10Km: '相距 ≤ 10 km' }

const printIds = (ids, indent = '      ') => {
  for (const id of ids) console.log(`${indent}${id}`)
}

const describeDiff = (label, diff) => {
  if (!diff) return
  if (diff.equal) {
    console.log(`  ${label}：通过。`)
    return
  }
  console.log(`  ${label}：共 ${diff.total} 处差异${diff.total > diff.paths.length ? `，以下是前 ${diff.paths.length} 处` : ''}（JSON 路径）：`)
  printIds(diff.paths, '    ')
}

const printSummary = (report, { mode, apply, details, dataLabel }) => {
  console.log(`StarMap 身份迁移（RFC-LOC-1）· ${apply ? 'apply' : 'dry-run'} · ${dataLabel}`)
  console.log(`旧文件哈希：${report.sourceHash}`)
  console.log(`规划时间：${report.plannedAt}`)
  console.log('')

  console.log('计数（迁移前 → 迁移后）：')
  for (const [key, label] of COUNT_LABELS) console.log(`  ${label}：${report.counts.before[key]} → ${report.counts.after[key]}`)
  const refKeys = [...new Set([...Object.keys(report.counts.before.editorStateRefs), ...Object.keys(report.counts.after.editorStateRefs)])]
  for (const key of refKeys) {
    console.log(`  editor-state ${key}：${report.counts.before.editorStateRefs[key] ?? 0} → ${report.counts.after.editorStateRefs[key] ?? 0}`)
  }
  console.log('')

  console.log(`错误：${report.errors.length}`)
  for (const error of report.errors) {
    console.log(`  [${error.code}] ${error.message}`)
    if (error.ids.length > 0) {
      if (details) printIds(error.ids, '    ')
      else console.log(`    （${error.ids.length} 个 id，加 --details 列出）`)
    }
  }
  console.log('')

  const decided = report.needsDecision.filter((item) => item.decision !== undefined).length
  console.log(`需确认：${report.needsDecision.length}（已决定 ${decided}，未决定 ${report.needsDecision.length - decided}）`)
  for (const item of report.needsDecision) {
    const extra = [
      item.reasons ? `依据：${item.reasons.map((reason) => REASON_LABELS[reason]).join('、')}` : undefined,
      item.distanceKm !== undefined ? `相距 ${item.distanceKm.toFixed(1)} km` : undefined,
      item.kind === 'coordinateDifference' && !item.intoHasLocation ? '足迹一侧没有坐标' : undefined,
    ].filter(Boolean).join('；')
    const status = item.decision === undefined ? `未决定（可选：${item.options.join(' / ')}）` : `已决定：${item.decision}`
    console.log(`  [${item.kind}] ${DECISION_TABLES[item.kind]}["${item.key}"]  ${status}${extra ? `  ${extra}` : ''}`)
  }
  if (report.needsDecision.length > 0) console.log('  （两边的名称写在 --report 的 needsDecision 里；决定照抄键写进决定文件对应的表。）')
  console.log('')

  console.log(`提示：${report.info.length} 条`)
  for (const entry of report.info) {
    console.log(`  [${entry.code}] ${entry.message}`)
    if (details && entry.ids.length > 0) printIds(entry.ids)
  }
  console.log('')

  if (details) {
    console.log(`地点（旧 id → 新 id）：${report.places.length}`)
    for (const place of report.places) {
      console.log(`  ${place.subtype === 'country' ? '国家' : '城市'}  ${place.oldId} → ${place.newId}${place.allocated ? '（新分配）' : ''}`)
    }
    console.log('')
  }

  const aVsAPrime = report.aVsAPrime
  if (aVsAPrime.equal) {
    console.log('A 与 A′（合并与决定带来的显示变化，只报告）：逐字节相同。')
  } else {
    console.log(`A 与 A′（合并与决定带来的显示变化，只报告）：共 ${aVsAPrime.total} 处差异${aVsAPrime.total > aVsAPrime.paths.length ? `，以下是前 ${aVsAPrime.paths.length} 处` : ''}（JSON 路径）：`)
    printIds(aVsAPrime.paths, '  ')
  }
  console.log('')

  console.log('shadow compare：')
  if (!report.roundTrip.ran) {
    console.log(`  未运行：${report.roundTrip.skippedBecause}。`)
  } else {
    describeDiff('写出再读回（read(write(M)) 与 M 相同）', report.roundTrip.diff)
    if (report.shadow.ran) {
      describeDiff('Canonical 层（读回映射回旧 id 后与 L′ 逐项相同）', report.shadow.canonical)
      describeDiff('派生层（A′ 与 B 逐字节相同）', report.shadow.derived)
    } else {
      console.log(`  未运行：${report.shadow.skippedBecause}。`)
    }
  }
  console.log('')

  const reasons = []
  if (report.errors.length > 0) reasons.push(`${report.errors.length} 个错误`)
  if (decided < report.needsDecision.length) reasons.push(`${report.needsDecision.length - decided} 项待决定`)
  if (!report.shadow.ran) reasons.push('shadow compare 未运行')
  console.log(`canApply：${report.canApply}${report.canApply ? '' : `（${reasons.join('，')}）`}`)
  if (mode === 'sample' && !apply) console.log('（--sample 默认不写任何文件。）')
}

// ---- 写出 ----

/**
 * 输出目录不存在或为空。`manifestPath` 若恰好在这个目录里（公开样例的固定清单），它本身不算（RFC-LOC-1 PR4）；
 * 目录里的其他任何东西（包括清单的 `.bak`）都算非空。
 */
const isEmptyOrMissingDirectory = async (directory, manifestPath) => {
  let info
  try {
    info = await stat(directory)
  } catch (error) {
    if (error?.code === 'ENOENT') return true
    throw error
  }
  if (!info.isDirectory()) return false
  const manifestHere = manifestPath !== undefined && canonicalPath(path.dirname(path.resolve(manifestPath))) === canonicalPath(directory)
  const ignored = manifestHere ? path.basename(manifestPath) : undefined
  return (await readdir(directory)).filter((name) => name !== ignored).length === 0
}

const writeText = async (filePath, text) => {
  await mkdir(path.dirname(path.resolve(filePath)), { recursive: true })
  await writeFile(filePath, text, 'utf8')
}

/** 写出五个 V2 文件（`fileNames`：私人目录用 V2_FILE_NAMES，--sample 用不带 .local 的 V2_SAMPLE_FILE_NAMES），再从磁盘读回校验。 */
const applyFiles = async (outDir, files, fileNames) => {
  await mkdir(outDir, { recursive: true })
  for (const key of V2_FILE_KEYS) await atomicJsonWrite(path.join(outDir, fileNames[key]), files[key])

  // 从磁盘读回，逐个校验。
  const written = {}
  console.log(`已写入 ${path.resolve(outDir)}：`)
  for (const key of V2_FILE_KEYS) {
    const filePath = path.join(outDir, fileNames[key])
    const bytes = await readFile(filePath)
    written[key] = JSON.parse(bytes.toString('utf8'))
    console.log(`  ${fileNames[key]}  ${bytes.length} 字节`)
  }
  const problems = validateV2Files(written)
  if (problems.length > 0) {
    console.log(`写出的文件有 ${problems.length} 处没通过 V2 校验：`)
    for (const problem of problems) console.log(`  ${fileNames[problem.file]} ${problem.path}：${problem.message}`)
    return false
  }
  console.log(`五个文件从磁盘读回后都通过 V2 校验（地点 ${written.places.places.length} 个）。`)
  return true
}

// ---- 主流程 ----

const run = async (options) => {
  const mode = options.sample ? 'sample' : 'personal'
  const paths = mode === 'personal' ? getPrivatePaths() : undefined
  const migrationRoot = paths ? path.join(paths.dataRoot, 'migration') : undefined
  const manifestPath = options.manifest ?? (migrationRoot && path.join(migrationRoot, 'identity-manifest.local.json'))
  const decisionsPath = options.decisions ?? (migrationRoot && path.join(migrationRoot, 'identity-decisions.local.json'))
  const outDir = options.outDir ?? (paths && path.join(paths.dataRoot, 'v2'))

  // 隐私门：在读取任何私人文件之前。
  if (mode === 'personal') {
    console.error(`[migrate-identity] 个人模式，私人根目录：${paths.root}`)
    for (const [flag, target] of [['--report', options.report], ['--out-dir', options.outDir]]) {
      if (target !== undefined && !isAllowedPrivateOutput(target)) {
        throw new PrivacyGateError(`拒绝写入：${flag} ${path.resolve(target)} 位于 Git 仓库 ${sourceRoot} 之内（且不在私人根目录之内）。私人数据的迁移结果与报告只能写到私人根目录之内或仓库之外。`)
      }
    }
    if (options.switch) {
      // --switch 切换后 App 只读 data/v2/：输出写到别处再切，App 读到的是空目录或旧的 V2 文件。
      if (options.outDir !== undefined && canonicalPath(options.outDir) !== canonicalPath(paths.v2DataRoot)) {
        throw new UsageError(`--switch 只能把 V2 文件写到私人目录的 ${paths.v2DataRoot}（V2 模式下 App 只读那里），不能与其他 --out-dir 同用。`)
      }
      // 标记文件的隐私门也在写任何文件之前检查（DataModeMarkerWriteRefused，退出码 2）。
      assertDataModeMarkerWritable(paths)
    }
    // RFC-LOC-1 PR4 规格 §2.2（PR3b-1 发现 5）：先看有没有旧数据。PR4 起全新私人目录默认就是 V2，
    // 在上面跑迁移（包括 --apply）应当得到「无需迁移」（退出码 0），而不是被下面的 V2 检查拒绝。
    // 这里只看四个旧文件在不在（existsSync），不读内容。
    if (!hasLegacyData(paths)) {
      console.log('私人目录没有旧数据，无需迁移。')
      return 0
    }
    // RFC-LOC-1 PR3b-1 §2.3：V2 数据模式下 data/v2/ 是正在使用的数据，--apply 不得运行（退出码 2）；dry-run 照常。
    // 标记文件不合法时 resolveDataMode 抛 DataModeMarkerError（退出码 1）。都在读取任何私人文件之前。
    if (options.apply && resolveDataMode(paths).mode === 'v2') {
      throw new DataModeRefusal(`私人目录当前为 V2 数据模式（${paths.dataModePath}）：data/v2/ 是正在使用的数据，--apply 不能运行。dry-run 仍可运行。`)
    }
  }

  const loaded = mode === 'sample' ? await loadSample() : await loadPrivate(paths)
  if (!loaded) {
    console.log('私人目录没有旧数据，无需迁移。')
    return 0
  }

  const manifest = manifestPath ? await readIdentityFile(manifestPath, parseIdentityManifest, { required: false }) : undefined
  const decisions = decisionsPath
    ? await readIdentityFile(decisionsPath, parseIdentityDecisions, { required: options.decisions !== undefined })
    : undefined

  // --now（只在 --sample 下可用，parseArgs 已检查）固定规划时间，让公开样例的生成逐字节可复现。
  const now = options.now ?? new Date().toISOString()
  const raw = { ...loaded.raw, now }
  const result = planMigration({
    raw,
    fileMeta: fileMetaFromRaw(raw),
    ...(manifest ? { manifest } : {}),
    ...(decisions ? { decisions } : {}),
    sourceHash: loaded.sourceHash,
    newId: () => uuidv7(),
    now,
  })
  const { report } = result

  printSummary(report, {
    mode,
    apply: options.apply,
    details: options.details,
    dataLabel: mode === 'sample' ? '公开样例（--sample）' : '私人目录',
  })

  if (options.report !== undefined) {
    await writeText(options.report, `${JSON.stringify(report, null, 2)}\n`)
    console.log(`已写入报告 ${path.resolve(options.report)}`)
  }

  if (!options.apply) {
    if (manifestPath) {
      await atomicJsonWrite(manifestPath, result.manifest)
      console.log(`已写回迁移清单 ${path.resolve(manifestPath)}（记录本次旧文件哈希）。`)
    }
    return 0
  }

  // ---- --apply 的门槛 ----
  console.log('')
  const refusals = []
  if (!report.canApply) refusals.push('canApply 为 false。')
  if (manifestPath) {
    if (!manifest) refusals.push(`没有迁移清单 ${path.resolve(manifestPath)}：请先 dry-run。`)
    else if (manifest.sourceHash !== loaded.sourceHash) refusals.push('迁移清单记录的旧文件哈希与当前不同（数据在上次 dry-run 之后变过）：请先重新 dry-run。')
  }
  if (!(await isEmptyOrMissingDirectory(outDir, manifestPath))) refusals.push(`输出目录 ${path.resolve(outDir)} 不是空目录。`)
  // RFC-LOC-1 PR4：--sample 额外放行 src/data/v2-sample/ 这一个目录（公开样例，不含私人数据）；仓库内其他位置照旧拒绝。
  const sampleDirectory = mode === 'sample' && isV2SampleDirectory(outDir)
  if (!sampleDirectory && !isAllowedPrivateOutput(outDir)) refusals.push(`输出目录 ${path.resolve(outDir)} 位于 Git 仓库 ${sourceRoot} 之内（且不在私人根目录之内）。`)
  if (refusals.length > 0) {
    console.log('拒绝写出（--apply）：')
    for (const reason of refusals) console.log(`  - ${reason}`)
    return 2
  }

  if (!(await applyFiles(outDir, result.files, mode === 'sample' ? V2_SAMPLE_FILE_NAMES : V2_FILE_NAMES))) return 1
  const allocated = report.places.filter((place) => place.allocated).length
  if (manifestPath && allocated > 0) {
    await atomicJsonWrite(manifestPath, result.manifest)
    console.log(`迁移清单新分配了 ${allocated} 个 UUID，已写回 ${path.resolve(manifestPath)}。`)
  }
  if (!options.switch) {
    console.log('没有写数据模式标记文件，旧文件未改动。')
    return 0
  }
  // --switch（RFC-LOC-1 PR4 规格 §2.2）：V2 文件已写出并从磁盘读回校验通过，再原子写入标记。
  const markerPath = await writeDataModeMarker(paths, 'v2')
  console.log(`已写入数据模式标记 ${markerPath}：{ "mode": "v2" }。App 与各脚本从现在起读写 data/v2/；旧文件未改动。`)
  console.log('回滚：npm run data-mode -- legacy（切回旧文件；在 V2 模式下做的编辑不会带回旧文件）。')
  return 0
}

try {
  process.exitCode = await run(parseArgs(process.argv.slice(2)))
} catch (error) {
  if (error instanceof PrivacyGateError || error instanceof DataModeRefusal || error instanceof DataModeMarkerWriteRefused) {
    console.error(`[migrate-identity] ${error.message}`)
    process.exitCode = 2
  } else if (error instanceof DataModeMarkerError) {
    console.error(`[migrate-identity] ${error.message}`)
    process.exitCode = 1
  } else if (error instanceof UsageError) {
    console.error(`[migrate-identity] ${error.message}\n${usage}`)
    process.exitCode = 1
  } else if (error instanceof ReadError) {
    console.error(`[migrate-identity] ${error.message}`)
    process.exitCode = 1
  } else {
    // 走到这里的是规划或写出时的程序错误，不含文件内容。
    console.error(`[migrate-identity] 失败：${error?.stack ?? error}`)
    process.exitCode = 1
  }
}
