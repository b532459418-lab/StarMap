/**
 * 公开样例的 V2 文件 src/data/v2-sample/（RFC-LOC-1 PR4 规格 §2.3、§3「V2 样例」「隐私审计」；PR5b 决定 L）。
 *
 * PR5b 起这五个文件是唯一来源、手工维护：生成器（`sample:v2`）、固定的迁移清单与它们的「可复现」「shadow compare」用例
 * 随迁移工具删除；派生结果由 src/data/canonical/derive.test.ts 的基线锁定钉住（77cd872b…）。这里测：
 * - 已提交文件通过 validateV2Files，目录里只有五个文件；
 * - 行尾在任何检出里都是 LF；
 * - canonicalForInputs 的来源参数与 App 接线；
 * - 隐私审计对 V2 样例的每条规则至少一个反例（在临时副本上改坏，不改已提交文件）。
 *
 * 运行方式：npm test。只读已提交文件；写入只发生在 fs.mkdtemp 建的临时目录里，用例结束时删除。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  auditV2SampleDirectory,
  readV2SampleFiles,
  V2_SAMPLE_ALLOWED_FILES,
  V2_SAMPLE_DIRECTORY,
  V2_SAMPLE_FILE_NAMES,
} from './v2-sample.mjs'
import { canonicalForInputs } from '../src/data/canonical/canonicalForInputs.ts'
import { V2_FILE_KEYS, validateV2Files } from '../src/data/canonical/v2Schema.ts'

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// ---------------------------------------------------------------------------
// 已提交文件
// ---------------------------------------------------------------------------

test('已提交的 V2 样例：五个文件通过 validateV2Files；目录里只有这五个文件；隐私审计通过', () => {
  const files = readV2SampleFiles()
  assert.ok(V2_FILE_KEYS.every((key) => files[key] !== undefined))
  assert.deepEqual(validateV2Files(files), [])
  assert.deepEqual(readdirSync(V2_SAMPLE_DIRECTORY).sort(), [...V2_SAMPLE_ALLOWED_FILES])
  assert.deepEqual(auditV2SampleDirectory(), [])
})

test('行尾：V2 样例在任何检出里都是 LF（PR5b 删除了两份旧样例与它们的规则）', () => {
  const rules = readFileSync(path.join(webRoot, '..', '.gitattributes'), 'utf8').split(/\r?\n/)
  assert.ok(rules.includes('01_Web/src/data/v2-sample/*.json text eol=lf'), '.gitattributes 缺少 V2 样例的规则')
  assert.equal(rules.some((rule) => rule.includes('.sample.json')), false, '旧样例的规则已删除')
  const files = V2_SAMPLE_ALLOWED_FILES.map((name) => path.join(V2_SAMPLE_DIRECTORY, name))
  for (const file of files) assert.equal(readFileSync(file).includes(13), false, `${file} 含有 CR（检出时被改成了 CRLF？）`)
})

test('canonicalForInputs 的来源参数：缺省为 local（与 PR3b 相同），sample 只改 travel.source 与 wantToGo.source', () => {
  const files = readV2SampleFiles()
  const local = canonicalForInputs({ v2Files: files })
  const explicitLocal = canonicalForInputs({ v2Files: files, source: 'local' })
  const sample = canonicalForInputs({ v2Files: files, source: 'sample' })
  assert.equal(local.travel.source, 'local')
  assert.equal(local.wantToGo.source, 'local')
  assert.deepEqual(explicitLocal, local)
  assert.deepEqual(
    { ...sample, travel: { ...sample.travel, source: 'local' }, wantToGo: { ...sample.wantToGo, source: 'local' } },
    local,
  )
  const empty = canonicalForInputs({ v2Files: undefined, source: 'sample' })
  assert.equal(empty.travel.source, 'sample')
  assert.equal(empty.places.length, 0)
})

test('App 接线：rawInputs.ts 静态 import 五个 V2 样例文件（文件名同 V2_SAMPLE_FILE_NAMES），不再 import 任何旧样例（PR5a 起足迹样例也不）', () => {
  const source = readFileSync(path.join(webRoot, 'src', 'data', 'rawInputs.ts'), 'utf8')
  for (const name of Object.values(V2_SAMPLE_FILE_NAMES)) {
    assert.match(source, new RegExp(`^import \\w+ from './v2-sample/${name.replace('.', '\\.')}'$`, 'm'), name)
  }
  assert.doesNotMatch(source, /want-to-go\.sample\.json|travel-map\.sample\.json/)
  assert.match(source, /\{ v2Files: v2SampleFiles, source: 'sample' \}/)
})

// ---------------------------------------------------------------------------
// 隐私审计（scripts/v2-sample.mjs 的 auditV2SampleDirectory，privacy-audit.mjs 调用它）
// ---------------------------------------------------------------------------

/** 已提交目录的临时副本，交给 `mutate` 改坏，返回审计结果。 */
const auditBroken = (mutate) => withTempResult(async (directory) => {
  const copy = path.join(directory, 'v2-sample')
  await cp(V2_SAMPLE_DIRECTORY, copy, { recursive: true })
  await mutate(copy)
  return auditV2SampleDirectory(copy)
})

const withTempResult = async (run) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'starmap-v2-sample-audit-'))
  try {
    return await run(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

const editJson = async (directory, key, edit) => {
  const filePath = path.join(directory, V2_SAMPLE_FILE_NAMES[key])
  const value = JSON.parse(await readFile(filePath, 'utf8'))
  edit(value)
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

const assertOneError = (errors, pattern) => {
  assert.equal(errors.filter((error) => pattern.test(error)).length, 1, `${pattern}\n${errors.join('\n')}`)
}

test('隐私审计：未改动的副本通过', async () => {
  assert.deepEqual(await auditBroken(async () => {}), [])
})

test('隐私审计反例：足迹与想去的 privacy_level 不是 public-sample', async () => {
  const travel = await auditBroken((copy) => editJson(copy, 'travel', (value) => { value.privacy_level = 'local-only' }))
  assertOneError(travel, /travel-map\.json must declare privacy_level = public-sample/)
  const wantToGo = await auditBroken((copy) => editJson(copy, 'wantToGo', (value) => { delete value.privacy_level }))
  assertOneError(wantToGo, /want-to-go\.json must declare privacy_level = public-sample/)
})

test('隐私审计反例：没有足迹记录；没有想去条目', async () => {
  const noRecords = await auditBroken((copy) => editJson(copy, 'travel', (value) => { value.records = [] }))
  assertOneError(noRecords, /travel-map\.json needs at least one runnable sample record/)
  const noItems = await auditBroken((copy) => editJson(copy, 'wantToGo', (value) => { value.items = [] }))
  assertOneError(noItems, /want-to-go\.json needs a non-empty items array/)
})

test('隐私审计反例：想去条目 id 不以 wtg_ 开头；有隐藏条目；有 source: local-editor 的条目', async () => {
  const badId = await auditBroken((copy) => editJson(copy, 'wantToGo', (value) => { value.items[0].id = 'item_nuuk' }))
  assertOneError(badId, /item ids must start with wtg_:\n {2}- item_nuuk/)
  const hidden = await auditBroken((copy) => editJson(copy, 'wantToGo', (value) => { value.items[1].hidden = true }))
  assertOneError(hidden, /must not contain hidden items:\n {2}- wtg_2026-08-12_tromso/)
  const editor = await auditBroken((copy) => editJson(copy, 'wantToGo', (value) => { value.items[2].source = 'local-editor' }))
  assertOneError(editor, /must not contain items written by the local editor.*:\n {2}- wtg_2026-08-12_akureyri/s)
})

test('隐私审计反例：目录里多出文件（.bak、.local 文件、子目录）', async () => {
  const extra = await auditBroken(async (copy) => {
    await writeFile(path.join(copy, 'places.bak'), '{}', 'utf8')
    await writeFile(path.join(copy, 'travel-map.local.json'), '{}', 'utf8')
    await mkdir(path.join(copy, 'media'))
  })
  assertOneError(extra, /may contain only/)
  const message = extra.find((error) => /may contain only/.test(error))
  assert.match(message, /- media\n {2}- places\.bak\n {2}- travel-map\.local\.json$/)
})

test('隐私审计反例：五个文件没通过 validateV2Files（记录引用了不存在的地点）；缺文件；不是有效 JSON', async () => {
  const invalid = await auditBroken((copy) => editJson(copy, 'travel', (value) => { value.records[0].placeId = '01a0ed02-0000-7000-8000-000000000000' }))
  assertOneError(invalid, /must pass validateV2Files \(1 problem\(s\)\):\n {2}- travel-map\.json \$\.records\[0\]\.placeId/)
  const missing = await auditBroken((copy) => rm(path.join(copy, V2_SAMPLE_FILE_NAMES.media)))
  assertOneError(missing, /user-media\.json must exist/)
  const broken = await auditBroken((copy) => writeFile(path.join(copy, V2_SAMPLE_FILE_NAMES.editorState), '{ nope', 'utf8'))
  assertOneError(broken, /editor-state\.json must be valid JSON/)
  const noDirectory = auditV2SampleDirectory(path.join(tmpdir(), 'starmap-v2-sample-does-not-exist'))
  assertOneError(noDirectory, /must exist: public mode reads the V2 sample/)
})
