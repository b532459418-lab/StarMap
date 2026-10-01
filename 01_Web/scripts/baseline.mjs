/**
 * 派生基线工具（RFC-LOC-1 PR1 §3.3；PR5b 由 legacy-baseline.mjs 改名，只留 V2 的两种输入）。
 *
 * 把「App 从某份数据派生出的全部结果」固定成一份可逐字节比较的 JSON：
 * 五个 V2 文件 → src/data/canonical/canonicalForInputs.ts（V2 Reader）→ src/data/canonical/derive.ts 的
 * deriveAppDataFromCanonical → src/data/derive/baseline.ts 的 buildBaseline / stableStringify。
 * 只读：除 --out 指定的文件外不写任何东西。
 *
 *   node scripts/baseline.mjs --sample --out <file>        公开模式：已提交的公开样例 src/data/v2-sample/
 *   node scripts/baseline.mjs --out <file>                 个人模式：私人目录 data/v2/ 的五个 V2 文件
 *   node scripts/baseline.mjs --compare <a.json> <b.json>  逐字节比较；不同时列出前 50 处差异的 JSON 路径
 *
 * 数据的选择与 App 在对应模式下的实际选择一致（src/data/rawInputs.ts）：
 * - 公开模式（--sample）：公开样例的五个 V2 文件，来源标为 sample——与 App 在公开模式和强制样例下读的输入相同。
 *   不读任何私人文件，所以没有隐私门。
 * - 个人模式：与虚拟模块相同，五个 V2 文件都用 readJson(path, undefined) 读——不存在为 undefined，按空处理
 *   （五个都缺时是空数据，不回落到样例）；不是有效 JSON、或没通过 V2 校验，报错退出（App 此时同样加载失败）。
 *   地点 id 是 UUID，不做映射。旧格式的私人文件与 PR4 的数据模式标记都不读。
 * - 不模拟强制样例模式（VITE_TRAVEL_ATLAS_DATA_MODE=sample、?data=sample）：它读的就是 --sample 的输入。
 * - now 固定为 2000-01-01T00:00:00.000Z；基线里恰好等于 now 的字符串都会被替换成 "<now>"。
 *
 * 隐私门：个人模式的基线含地名与坐标。--out 解析后（含符号链接）只能在私人根目录之内
 * （即使私人根在仓库里，例如独立克隆的 06_private/）或本 Git 仓库之外（判断见 private-output.mjs），
 * 否则拒绝并以退出码 2 结束，且不读取任何私人文件。--sample 不限制。
 * 读取失败时只报文件路径与失败类别，不打印文件内容（JSON 解析错误的消息会带出原文片段）。
 *
 * 退出码：成功 0；--compare 有差异 1；参数错误 / 读取失败 / V2 文件不合法 1；隐私门拒绝 2。
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { readJson } from './json-file.mjs'
import { isAllowedPrivateOutput } from './private-output.mjs'
import { getPrivatePaths, sourceRoot } from './private-profile.mjs'
import { readV2SampleFiles, V2_SAMPLE_DIRECTORY } from './v2-sample.mjs'
import { buildBaseline, stableStringify } from '../src/data/derive/baseline.ts'
import { canonicalForInputs, V2FilesInvalidError } from '../src/data/canonical/canonicalForInputs.ts'
import { deriveAppDataFromCanonical } from '../src/data/canonical/derive.ts'

const BASELINE_NOW = '2000-01-01T00:00:00.000Z'
const MAX_REPORTED_DIFFERENCES = 50

const usage = [
  '用法：',
  '  node scripts/baseline.mjs --sample --out <file>',
  '  node scripts/baseline.mjs --out <file>',
  '  node scripts/baseline.mjs --compare <a.json> <b.json>',
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
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--sample' && !sample) {
      sample = true
    } else if (arg === '--out' && out === undefined) {
      const value = argv[index + 1]
      if (!value || value.startsWith('--')) throw new UsageError('--out 后面需要一个文件路径。')
      out = value
      index += 1
    } else {
      throw new UsageError(`无法识别的参数：${arg}`)
    }
  }
  if (out === undefined) throw new UsageError('缺少 --out <file>。')
  return { mode: sample ? 'sample' : 'personal', out }
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

/** 个人模式：私人目录 data/v2/ 的五个 V2 文件（不存在为 undefined，按空处理）。与虚拟模块读的相同。 */
const loadPrivateInputs = async () => {
  const { v2FilePaths } = getPrivatePaths()
  const v2Files = {}
  for (const [key, filePath] of Object.entries(v2FilePaths)) v2Files[key] = await readPrivateJson(filePath)
  return { v2Files }
}

/** 公开模式：已提交的公开样例，来源标为 sample——与 App 在公开模式和强制样例下读的输入相同（src/data/rawInputs.ts）。 */
const loadSampleInputs = () => {
  try {
    return { v2Files: readV2SampleFiles(), source: 'sample' }
  } catch (error) {
    throw new ReadError(`读取失败：${V2_SAMPLE_DIRECTORY}（${describeReadFailure(error)}）`)
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
  console.error(`[baseline] 个人模式，私人根目录：${getPrivatePaths().root}`)
  if (!isAllowedPrivateOutput(target)) {
    throw new PrivacyGateError(
      `拒绝写入：${path.resolve(target)} 位于 Git 仓库 ${sourceRoot} 之内（且不在私人根目录之内）。个人模式的基线含地名与坐标，只能写到私人根目录之内或仓库之外。`,
    )
  }
}

/** canonicalForInputs（V2 Reader）→ deriveAppDataFromCanonical → 基线，末尾换行。与 App 的管线相同。 */
const baselineText = (inputs) =>
  `${stableStringify(buildBaseline(deriveAppDataFromCanonical(canonicalForInputs(inputs), { now: BASELINE_NOW }), { now: BASELINE_NOW }))}\n`

const writeText = async (filePath, text) => {
  const outPath = path.resolve(filePath)
  await mkdir(path.dirname(outPath), { recursive: true })
  await writeFile(outPath, text, 'utf8')
  return outPath
}

const describeText = (text) => `${Buffer.byteLength(text, 'utf8')} 字节，sha256 ${sha256(text)}`

const generate = async ({ mode, out }) => {
  checkPrivacyGate(mode, out)
  const text = baselineText(mode === 'sample' ? loadSampleInputs() : await loadPrivateInputs())
  const outPath = await writeText(out, text)
  console.log(`已写入 ${outPath}（${describeText(text)}）。`)
  return 0
}

try {
  const args = parseArgs(process.argv.slice(2))
  process.exitCode = args.mode === 'compare'
    ? await compare(args.first, args.second)
    : await generate(args)
} catch (error) {
  if (error instanceof PrivacyGateError) {
    console.error(`[baseline] ${error.message}`)
    process.exitCode = 2
  } else if (error instanceof UsageError) {
    console.error(`[baseline] ${error.message}\n${usage}`)
    process.exitCode = 1
  } else if (error instanceof ReadError || error instanceof V2FilesInvalidError) {
    // V2FilesInvalidError 的消息只列文件、JSON 路径与问题类别，不含字段的值。
    console.error(`[baseline] ${error.message}`)
    process.exitCode = 1
  } else {
    // 走到这里的是派生或写出时的程序错误，不含文件内容。
    console.error(`[baseline] 失败：${error?.stack ?? error}`)
    process.exitCode = 1
  }
}
