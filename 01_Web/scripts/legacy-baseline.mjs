/**
 * 旧逻辑基线工具（RFC-LOC-1 PR1 §3.3）。
 *
 * 把「App 从某份数据派生出的全部结果」固定成一份可逐字节比较的 JSON：
 * 选数据 → src/data/derive/appData.ts 的 deriveAppData → src/data/derive/baseline.ts 的
 * buildBaseline / stableStringify。只读：除 --out 指定的文件外不写任何东西。
 *
 *   node scripts/legacy-baseline.mjs --sample --out <file>        公开模式语义
 *   node scripts/legacy-baseline.mjs --out <file>                 个人模式语义（读 getPrivatePaths() 的文件）
 *   node scripts/legacy-baseline.mjs --compare <a.json> <b.json>  逐字节比较；不同时列出前 50 处差异的 JSON 路径
 *
 * RFC-LOC-1 PR2 增加（不改上面三种用法的行为）：
 *   --path legacy|canonical   选择派生路径，默认 legacy（PR1 的 deriveAppData）；canonical 是
 *                             Legacy Adapter → Canonical → deriveAppDataFromCanonical（PR2 之后 App 的路径）
 *   --normalize               仅对 legacy 路径：先跑 normalizeLegacy（把每个地点的写法统一成适配器的选择）
 *   --verify [--details] [--out-dir <dir>]
 *                             一次算出三份基线：A = 旧路径跑原始数据，B = 旧路径跑 normalizeLegacy(原始数据)，
 *                             C = 新路径跑原始数据。打印 normalizeLegacy 报告的计数（--details 时加 id）、
 *                             A 与 B 的差异数与前 50 个路径、B 与 C 是否逐字节相同。B ≡ C 时退出码 0，否则 1。
 *                             不写任何文件，除非给了 --out-dir（写 a.json / b.json / c.json，规则同 --out）。
 *
 * 数据源选择与 App 在对应模式下的实际选择一致：
 * - 公开模式（--sample）：虚拟模块 virtual:starmap-private-data 不注入任何私有数据
 *   （local-editor-plugin.mjs 的 load()），所以足迹是样例、想去是样例（wantToGo.ts 规则 3），
 *   editor-state 与媒体目录为 undefined。
 * - 个人模式：与虚拟模块相同，四个私有文件都用 readJson(path, undefined) 读——不存在为 undefined，
 *   不是有效 JSON 则报错退出（App 此时同样加载失败）。足迹私有文件有效（有 records 数组）用私有，
 *   否则样例（travelAtlas.ts）；想去私有文件存在（不是 undefined / null）为 local，否则 none，
 *   不回落样例（wantToGo.ts 规则 2）。
 * - 不模拟强制样例模式（VITE_TRAVEL_ATLAS_DATA_MODE=sample、?data=sample）：它来自 Vite 的 env
 *   文件或 URL，基线只描述两种默认模式。
 * - now 固定为 2000-01-01T00:00:00.000Z；基线里恰好等于 now 的字符串都会被替换成 "<now>"。
 *
 * 隐私门：个人模式的基线含地名与坐标。--out / --out-dir 解析后（含符号链接）若位于本 Git 仓库之内，
 * 拒绝并以退出码 2 结束，且不读取任何私有文件。--sample 不限制。
 * 读取失败时只报文件路径与失败类别，不打印文件内容（JSON 解析错误的消息会带出原文片段）。
 *
 * 退出码：成功 0；--compare 有差异 1；--verify 时 B 与 C 不同 1；参数错误 / 读取失败 1；隐私门拒绝 2。
 */

import { createHash } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { readJson } from './json-file.mjs'
import { getPrivatePaths, sourceRoot, webRoot } from './private-profile.mjs'
import { deriveAppData } from '../src/data/derive/appData.ts'
import { buildBaseline, stableStringify } from '../src/data/derive/baseline.ts'
import { isTravelMapExport } from '../src/data/derive/travelAtlas.ts'
import { deriveAppDataFromCanonical } from '../src/data/canonical/derive.ts'
import { legacyAdapter } from '../src/data/canonical/legacyAdapter.ts'
import { normalizeLegacy } from '../src/data/canonical/normalizeLegacy.ts'

const BASELINE_NOW = '2000-01-01T00:00:00.000Z'
const MAX_REPORTED_DIFFERENCES = 50

const usage = [
  '用法：',
  '  node scripts/legacy-baseline.mjs --sample --out <file> [--path legacy|canonical] [--normalize]',
  '  node scripts/legacy-baseline.mjs --out <file> [--path legacy|canonical] [--normalize]',
  '  node scripts/legacy-baseline.mjs --verify [--sample] [--details] [--out-dir <dir>]',
  '  node scripts/legacy-baseline.mjs --compare <a.json> <b.json>',
].join('\n')

class UsageError extends Error {}
class PrivacyGateError extends Error {}
class ReadError extends Error {}

const parseArgs = (argv) => {
  if (argv[0] === '--compare') {
    if (argv.length !== 3) throw new UsageError('--compare 需要且只需要两个文件。')
    return { mode: 'compare', first: argv[1], second: argv[2] }
  }

  let sample = false
  let out
  let derivePath
  let normalize = false
  let verify = false
  let details = false
  let outDir
  const valueAfter = (index, message) => {
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) throw new UsageError(message)
    return value
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--sample' && !sample) {
      sample = true
    } else if (arg === '--out' && out === undefined) {
      out = valueAfter(index, '--out 后面需要一个文件路径。')
      index += 1
    } else if (arg === '--path' && derivePath === undefined) {
      derivePath = valueAfter(index, '--path 后面需要 legacy 或 canonical。')
      if (derivePath !== 'legacy' && derivePath !== 'canonical') throw new UsageError('--path 只能是 legacy 或 canonical。')
      index += 1
    } else if (arg === '--normalize' && !normalize) {
      normalize = true
    } else if (arg === '--verify' && !verify) {
      verify = true
    } else if (arg === '--details' && !details) {
      details = true
    } else if (arg === '--out-dir' && outDir === undefined) {
      outDir = valueAfter(index, '--out-dir 后面需要一个目录。')
      index += 1
    } else {
      throw new UsageError(`无法识别的参数：${arg}`)
    }
  }
  const mode = sample ? 'sample' : 'personal'
  if (verify) {
    if (out !== undefined || derivePath !== undefined || normalize) {
      throw new UsageError('--verify 自己算出 A、B、C 三份基线，不能与 --out、--path、--normalize 同用。')
    }
    return { mode, action: 'verify', details, outDir }
  }
  if (details || outDir !== undefined) throw new UsageError('--details 与 --out-dir 只能与 --verify 同用。')
  if (out === undefined) throw new UsageError('缺少 --out <file>。')
  if (normalize && derivePath === 'canonical') throw new UsageError('--normalize 只用于 legacy 路径。')
  return { mode, action: 'generate', out, derivePath: derivePath ?? 'legacy', normalize }
}

/** 最深的已存在祖先取真实路径（解开符号链接、目录联接与大小写），再接上不存在的部分。 */
const canonicalPath = (target) => {
  let existing = path.resolve(target)
  const missing = []
  while (!existsSync(existing)) {
    const parent = path.dirname(existing)
    if (parent === existing) break
    missing.unshift(path.basename(existing))
    existing = parent
  }
  try {
    return path.join(realpathSync.native(existing), ...missing)
  } catch {
    return path.resolve(target)
  }
}

/** 仓库根就是 private-profile.mjs 的 sourceRoot（01_Web 的上一级，Git 的根）。 */
const isInsideRepository = (target) => {
  const relative = path.relative(canonicalPath(sourceRoot), canonicalPath(target))
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

/** 读取失败只报路径与类别：JSON.parse 的错误消息会带出文件原文片段，私有文件不能这样泄露。 */
const describeReadFailure = (error) => {
  if (error instanceof SyntaxError) return '不是有效的 JSON'
  return error?.code ?? error?.name ?? '未知错误'
}

const readPrivateJson = async (filePath) => {
  try {
    return await readJson(filePath, undefined)
  } catch (error) {
    throw new ReadError(`读取失败：${filePath}（${describeReadFailure(error)}）`)
  }
}

const readSampleJson = async (fileName) => {
  const filePath = path.join(webRoot, 'src', 'data', fileName)
  try {
    return JSON.parse(await readFile(filePath, 'utf8'))
  } catch (error) {
    throw new ReadError(`读取失败：${filePath}（${describeReadFailure(error)}）`)
  }
}

const loadRawInputs = async (mode) => {
  const travelSample = await readSampleJson('travel-map.sample.json')

  if (mode === 'sample') {
    return {
      travelMap: travelSample,
      travelAtlasDataSource: 'sample',
      editorState: undefined,
      mediaCatalog: undefined,
      wantToGo: { source: 'sample', value: await readSampleJson('want-to-go.sample.json') },
      now: BASELINE_NOW,
    }
  }

  // 读取顺序与 local-editor-plugin.mjs 的虚拟模块相同。
  const paths = getPrivatePaths()
  const privateEditorState = await readPrivateJson(paths.editorStatePath)
  const privateMediaCatalog = await readPrivateJson(paths.mediaCatalogPath)
  const privateTravelMap = await readPrivateJson(paths.localTravelMapPath)
  const privateWantToGo = await readPrivateJson(paths.wantToGoPath)

  const localTravelMap = isTravelMapExport(privateTravelMap) ? privateTravelMap : undefined
  const hasLocalWantToGo = privateWantToGo !== undefined && privateWantToGo !== null

  return {
    travelMap: localTravelMap ?? travelSample,
    travelAtlasDataSource: localTravelMap ? 'local' : 'sample',
    editorState: privateEditorState,
    mediaCatalog: privateMediaCatalog,
    wantToGo: hasLocalWantToGo
      ? { source: 'local', value: privateWantToGo }
      : { source: 'none', value: undefined },
    now: BASELINE_NOW,
  }
}

const sha256 = (content) => createHash('sha256').update(content).digest('hex')

// ---- --compare ----

const kindOf = (value) => (value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value)

const formatKey = (key) => (/^[A-Za-z_$][\w$]*$/.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`)

/** 两份已解析的 JSON 的差异路径。只收集路径，不带值（基线可能含私人地名与坐标）。 */
const collectDifferences = (first, second) => {
  const paths = []
  let total = 0
  const report = (where) => {
    total += 1
    if (paths.length < MAX_REPORTED_DIFFERENCES) paths.push(where)
  }
  const walk = (left, right, where) => {
    const kind = kindOf(left)
    if (kind !== kindOf(right)) return report(where)
    if (kind === 'array') {
      const length = Math.max(left.length, right.length)
      for (let index = 0; index < length; index += 1) {
        const child = `${where}[${index}]`
        if (index >= left.length || index >= right.length) report(child)
        else walk(left[index], right[index], child)
      }
      return
    }
    if (kind === 'object') {
      const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()
      for (const key of keys) {
        const child = `${where}${formatKey(key)}`
        if (!Object.hasOwn(left, key) || !Object.hasOwn(right, key)) report(child)
        else walk(left[key], right[key], child)
      }
      return
    }
    if (!Object.is(left, right)) report(where)
  }
  walk(first, second, '$')
  return { paths, total }
}

const firstDifferentByte = (first, second) => {
  const length = Math.min(first.length, second.length)
  for (let index = 0; index < length; index += 1) {
    if (first[index] !== second[index]) return index
  }
  return length
}

const readBytes = async (filePath) => {
  try {
    return await readFile(filePath)
  } catch (error) {
    throw new ReadError(`读取失败：${filePath}（${describeReadFailure(error)}）`)
  }
}

const compare = async (firstPath, secondPath) => {
  // 依次读：两份都读不到时固定报第一份。
  const first = await readBytes(firstPath)
  const second = await readBytes(secondPath)

  if (first.equals(second)) {
    console.log(`相同：两份文件逐字节一致（${first.length} 字节，sha256 ${sha256(first)}）。`)
    return 0
  }

  console.log(`不同：${firstPath}（${first.length} 字节）与 ${secondPath}（${second.length} 字节）。`)
  let parsed
  try {
    parsed = [JSON.parse(first.toString('utf8')), JSON.parse(second.toString('utf8'))]
  } catch {
    console.log(`至少一份不是有效的 JSON；首个不同字节的偏移：${firstDifferentByte(first, second)}。`)
    return 1
  }

  const { paths, total } = collectDifferences(parsed[0], parsed[1])
  if (total === 0) {
    console.log(`解析后的 JSON 相同，只有格式或换行不同；首个不同字节的偏移：${firstDifferentByte(first, second)}。`)
    return 1
  }
  console.log(`共 ${total} 处差异${total > paths.length ? `，以下是前 ${paths.length} 处` : ''}（JSON 路径）：`)
  for (const where of paths) console.log(`  ${where}`)
  return 1
}

// ---- 生成基线 ----

/** 个人模式：先报出实际读取的私人根目录，再过隐私门；两者都在读任何私有文件之前。 */
const checkPrivacyGate = (mode, target) => {
  if (mode !== 'personal') return
  console.error(`[legacy-baseline] 个人模式，私人根目录：${getPrivatePaths().root}`)
  if (target !== undefined && isInsideRepository(target)) {
    throw new PrivacyGateError(
      `拒绝写入：${path.resolve(target)} 位于 Git 仓库 ${sourceRoot} 之内。个人模式的基线含地名与坐标，只能写到仓库之外。`,
    )
  }
}

const baselineText = (data) => `${stableStringify(buildBaseline(data, { now: BASELINE_NOW }))}\n`

/** 旧路径（PR1）：deriveAppData(原始数据)，或先 normalizeLegacy。 */
const legacyBaseline = (raw, { normalize = false } = {}) =>
  baselineText(deriveAppData(normalize ? normalizeLegacy(raw).normalized : raw))

/** 新路径（PR2）：Legacy Adapter → Canonical → deriveAppDataFromCanonical。 */
const canonicalBaseline = (raw) => baselineText(deriveAppDataFromCanonical(legacyAdapter(raw), { now: BASELINE_NOW }))

const writeText = async (filePath, text) => {
  const outPath = path.resolve(filePath)
  await mkdir(path.dirname(outPath), { recursive: true })
  await writeFile(outPath, text, 'utf8')
  return outPath
}

const describeText = (text) => `${Buffer.byteLength(text, 'utf8')} 字节，sha256 ${sha256(text)}`

const generate = async ({ mode, out, derivePath, normalize }) => {
  checkPrivacyGate(mode, out)
  const raw = await loadRawInputs(mode)
  const text = derivePath === 'canonical' ? canonicalBaseline(raw) : legacyBaseline(raw, { normalize })
  const outPath = await writeText(out, text)
  console.log(`已写入 ${outPath}（${describeText(text)}）。`)
  return 0
}

// ---- --verify ----

/** 打印两份基线的差异（只打印路径，不带值）；相同返回 true。 */
const printDifferences = (label, first, second) => {
  if (first === second) {
    console.log(`${label}：逐字节相同。`)
    return true
  }
  const { paths, total } = collectDifferences(JSON.parse(first), JSON.parse(second))
  if (total === 0) {
    console.log(`${label}：解析后的 JSON 相同，只有格式不同。`)
    return false
  }
  console.log(`${label}：共 ${total} 处差异${total > paths.length ? `，以下是前 ${paths.length} 处` : ''}（JSON 路径）：`)
  for (const where of paths) console.log(`  ${where}`)
  return false
}

const verify = async ({ mode, details, outDir }) => {
  checkPrivacyGate(mode, outDir)
  const raw = await loadRawInputs(mode)
  const { report } = normalizeLegacy(raw)
  const a = legacyBaseline(raw)
  const b = legacyBaseline(raw, { normalize: true })
  const c = canonicalBaseline(raw)

  console.log('normalizeLegacy 报告（数据里同一地点的写法不一致；只报告，不改数据文件）：')
  for (const category of report.categories) {
    console.log(`  ${category.label}：${category.count}`)
    if (details && category.ids.length > 0) console.log(`    ${category.ids.join(', ')}`)
  }
  console.log('')
  console.log(`A 旧路径 · 原始数据：${describeText(a)}`)
  console.log(`B 旧路径 · normalizeLegacy 之后：${describeText(b)}`)
  console.log(`C 新路径 · Legacy Adapter → Canonical：${describeText(c)}`)
  console.log('')
  printDifferences('A 与 B（写法统一带来的变化，只报告）', a, b)
  const same = printDifferences('B 与 C（适配器与派生的正确性，必须相同）', b, c)

  if (outDir !== undefined) {
    for (const [name, text] of [['a.json', a], ['b.json', b], ['c.json', c]]) {
      console.log(`已写入 ${await writeText(path.join(outDir, name), text)}`)
    }
  }
  console.log(same ? '通过：B ≡ C。' : '失败：B 与 C 不同。')
  return same ? 0 : 1
}

try {
  const args = parseArgs(process.argv.slice(2))
  process.exitCode = args.mode === 'compare'
    ? await compare(args.first, args.second)
    : args.action === 'verify'
      ? await verify(args)
      : await generate(args)
} catch (error) {
  if (error instanceof PrivacyGateError) {
    console.error(`[legacy-baseline] ${error.message}`)
    process.exitCode = 2
  } else if (error instanceof UsageError) {
    console.error(`[legacy-baseline] ${error.message}\n${usage}`)
    process.exitCode = 1
  } else if (error instanceof ReadError) {
    console.error(`[legacy-baseline] ${error.message}`)
    process.exitCode = 1
  } else {
    // 走到这里的是派生或写出时的程序错误，不含文件内容。
    console.error(`[legacy-baseline] 失败：${error?.stack ?? error}`)
    process.exitCode = 1
  }
}
