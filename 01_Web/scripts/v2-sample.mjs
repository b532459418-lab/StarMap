/**
 * 公开样例的 V2 文件（RFC-LOC-1 PR4 规格 §2.3）：`src/data/v2-sample/`。
 *
 * 目录里只有六个文件：五个 V2 文件（文件名不带 `.local`——它们是公开样例，不是私人数据）与一份固定的迁移清单
 * `identity-manifest.json`（保证每次生成的 UUID 相同）。公开模式与强制样例经 V2 Reader 读这五个文件
 * （src/data/rawInputs.ts 静态 import，文件名同下面的 V2_SAMPLE_FILE_NAMES）。
 *
 * 生成：`npm run sample:v2`（migrate-identity --sample --apply，见 package.json 与 01_Web/README.md）。
 * 隐私门在 --sample 下只额外放行这一个目录（`isV2SampleDirectory`，不含它的子目录）。
 *
 * 本模块给 migrate-identity、legacy-baseline（`--path v2-sample`）、privacy-audit 与测试共用：目录与文件名、
 * 读五个文件，以及隐私审计的规则 `auditV2SampleDirectory`（与旧样例的规则一一对应）。
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

import { canonicalPath } from './private-output.mjs'
import { webRoot } from './private-profile.mjs'
import { V2_FILE_KEYS, validateV2Files } from '../src/data/canonical/v2Schema.ts'

export const V2_SAMPLE_DIRECTORY = path.join(webRoot, 'src', 'data', 'v2-sample')

/** 五个 V2 文件在样例目录里的文件名：与私人目录 `data/v2/` 的文件名相同，只是去掉 `.local`。 */
export const V2_SAMPLE_FILE_NAMES = Object.freeze({
  places: 'places.json',
  travel: 'travel-map.json',
  wantToGo: 'want-to-go.json',
  editorState: 'editor-state.json',
  media: 'user-media.json',
})

/** 固定的迁移清单（「稳定来源键 → UUID」），`npm run sample:v2` 经 `--manifest` 读它。 */
export const V2_SAMPLE_MANIFEST_NAME = 'identity-manifest.json'

/** 样例目录里允许出现的全部文件。 */
export const V2_SAMPLE_ALLOWED_FILES = Object.freeze([...Object.values(V2_SAMPLE_FILE_NAMES), V2_SAMPLE_MANIFEST_NAME].sort())

/** `target` 恰好是样例目录本身（两边都先规范化：解开符号链接、目录联接与大小写）。子目录不算。 */
export const isV2SampleDirectory = (target) => canonicalPath(target) === canonicalPath(V2_SAMPLE_DIRECTORY)

/** 读样例目录（或它的副本）里的五个 V2 文件：键 → JSON 值；缺的为 undefined。不合法的 JSON 抛 SyntaxError。 */
export const readV2SampleFiles = (directory = V2_SAMPLE_DIRECTORY) => Object.fromEntries(V2_FILE_KEYS.map((key) => {
  const filePath = path.join(directory, V2_SAMPLE_FILE_NAMES[key])
  return [key, existsSync(filePath) ? JSON.parse(readFileSync(filePath, 'utf8')) : undefined]
}))

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * 隐私审计对 V2 样例的规则（PR4 规格 §2.3，与旧样例的检查一一对应）：
 * - 目录里只允许六个文件（五个 V2 文件与迁移清单），没有子目录、`.bak` 或其他文件；
 * - 五个 V2 文件都存在、是有效 JSON，并通过 `validateV2Files`；
 * - 足迹与想去文件的 `privacy_level` 为 `public-sample`；
 * - 至少一条足迹记录、至少一条想去条目；
 * - 想去条目 id 以 `wtg_` 开头，没有隐藏条目，没有 `source: 'local-editor'`。
 * 返回错误说明（英文，与 privacy-audit.mjs 其余信息一致）；空数组表示通过。只列 id 与路径，不打印其他内容。
 */
export function auditV2SampleDirectory(directory = V2_SAMPLE_DIRECTORY) {
  const label = 'src/data/v2-sample'
  const errors = []
  if (!existsSync(directory) || !statSync(directory).isDirectory()) {
    return [`${label}/ must exist: public mode reads the V2 sample from it.`]
  }

  const unexpected = readdirSync(directory).filter((name) => !V2_SAMPLE_ALLOWED_FILES.includes(name)).sort()
  if (unexpected.length > 0) {
    errors.push(`${label}/ may contain only ${V2_SAMPLE_ALLOWED_FILES.join(', ')}:\n${unexpected.map((name) => `  - ${name}`).join('\n')}`)
  }

  const files = {}
  for (const key of V2_FILE_KEYS) {
    const name = V2_SAMPLE_FILE_NAMES[key]
    const filePath = path.join(directory, name)
    if (!existsSync(filePath)) {
      errors.push(`${label}/${name} must exist.`)
      continue
    }
    try {
      files[key] = JSON.parse(readFileSync(filePath, 'utf8'))
    } catch {
      errors.push(`${label}/${name} must be valid JSON.`)
    }
  }
  if (V2_FILE_KEYS.some((key) => files[key] === undefined)) return errors

  const problems = validateV2Files(files)
  if (problems.length > 0) {
    const lines = problems.slice(0, 20).map((problem) => `  - ${V2_SAMPLE_FILE_NAMES[problem.file]} ${problem.path}: ${problem.message}`)
    errors.push(`${label}/ must pass validateV2Files (${problems.length} problem(s)):\n${lines.join('\n')}`)
  }

  const { travel, wantToGo } = files
  if (!isObject(travel) || travel.privacy_level !== 'public-sample') {
    errors.push(`${label}/${V2_SAMPLE_FILE_NAMES.travel} must declare privacy_level = public-sample.`)
  }
  if (!isObject(wantToGo) || wantToGo.privacy_level !== 'public-sample') {
    errors.push(`${label}/${V2_SAMPLE_FILE_NAMES.wantToGo} must declare privacy_level = public-sample.`)
  }
  const records = isObject(travel) && Array.isArray(travel.records) ? travel.records : []
  if (records.length === 0) errors.push(`${label}/${V2_SAMPLE_FILE_NAMES.travel} needs at least one runnable sample record.`)

  const items = isObject(wantToGo) && Array.isArray(wantToGo.items) ? wantToGo.items : []
  if (items.length === 0) errors.push(`${label}/${V2_SAMPLE_FILE_NAMES.wantToGo} needs a non-empty items array.`)
  const describeItem = (item, index) => (typeof item?.id === 'string' ? item.id : `item ${index + 1}`)
  const listItems = (predicate) => items
    .map((item, index) => (predicate(item) ? `  - ${describeItem(item, index)}` : undefined))
    .filter(Boolean)
    .join('\n')
  const badIds = listItems((item) => typeof item?.id !== 'string' || !item.id.startsWith('wtg_'))
  if (badIds) errors.push(`${label}/${V2_SAMPLE_FILE_NAMES.wantToGo} item ids must start with wtg_:\n${badIds}`)
  const hiddenItems = listItems((item) => item?.hidden === true)
  if (hiddenItems) errors.push(`${label}/${V2_SAMPLE_FILE_NAMES.wantToGo} must not contain hidden items:\n${hiddenItems}`)
  const editorItems = listItems((item) => item?.source === 'local-editor')
  if (editorItems) errors.push(`${label}/${V2_SAMPLE_FILE_NAMES.wantToGo} must not contain items written by the local editor (source = local-editor):\n${editorItems}`)
  return errors
}
