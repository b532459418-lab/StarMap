/**
 * 公开样例的 V2 文件 src/data/v2-sample/（RFC-LOC-1 PR4 规格 §2.3、§3「V2 样例」「隐私审计」）。
 *
 * - `npm run sample:v2` 的输出与已提交文件逐字节相同（按 package.json 里的命令原样运行，只把输出目录与清单换到临时目录）；
 * - 已提交文件通过 validateV2Files，目录里只有六个文件；
 * - 公开模式经 V2 样例派生的结果（来源 sample），经清单映射回旧 id 后，与旧样例经 Legacy Adapter 的 A′ 逐字节相同
 *   （PR3a 的 shadow compare 在已提交文件上成立）；
 * - migrate-identity 的隐私门在 --sample 下只多放行这一个目录；
 * - 隐私审计对 V2 样例的每条规则至少一个反例（在临时副本上改坏，不改已提交文件）。
 *
 * 运行方式：npm test。只读已提交文件；写入只发生在 fs.mkdtemp 建的临时目录里，用例结束时删除。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  auditV2SampleDirectory,
  isV2SampleDirectory,
  readV2SampleFiles,
  V2_SAMPLE_ALLOWED_FILES,
  V2_SAMPLE_DIRECTORY,
  V2_SAMPLE_FILE_NAMES,
  V2_SAMPLE_MANIFEST_NAME,
} from './v2-sample.mjs'
import { canonicalForInputs } from '../src/data/canonical/canonicalForInputs.ts'
import { V2_FILE_KEYS, validateV2Files } from '../src/data/canonical/v2Schema.ts'
import { stableStringify } from '../src/data/derive/baseline.ts'
import { parseIdentityManifest } from '../src/data/migration/identityFiles.ts'
import { fileMetaFromRaw, planMigration } from '../src/data/migration/planMigration.ts'
import { baselineOf, compareBaselines, mapUuidsBack, shadowCompare } from '../src/data/migration/shadowCompare.ts'

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const withTemp = async (run) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'starmap-v2-sample-test-'))
  try {
    await run(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

const runMigrate = (args, privateRoot) => spawnSync(process.execPath, [path.join(webRoot, 'scripts', 'migrate-identity.mjs'), ...args], {
  cwd: webRoot,
  env: { ...process.env, STARMAP_PRIVATE_ROOT: privateRoot },
  encoding: 'utf8',
})

/** package.json 里 sample:v2 的参数（去掉 `node scripts/migrate-identity.mjs`）。 */
const sampleV2Args = () => {
  const script = JSON.parse(readFileSync(path.join(webRoot, 'package.json'), 'utf8')).scripts['sample:v2']
  const parts = script.split(' ')
  assert.deepEqual(parts.slice(0, 2), ['node', 'scripts/migrate-identity.mjs'])
  return parts.slice(2)
}

const replaceValue = (args, flag, value) => {
  const index = args.indexOf(flag)
  assert.ok(index >= 0 && index + 1 < args.length, `sample:v2 没有 ${flag}`)
  return [...args.slice(0, index + 1), value, ...args.slice(index + 2)]
}

// ---------------------------------------------------------------------------
// 生成：npm run sample:v2
// ---------------------------------------------------------------------------

test('sample:v2 的命令：--sample --apply，输出到 src/data/v2-sample，读其中固定的迁移清单，--now 为旧足迹样例的 generated_at', () => {
  const args = sampleV2Args()
  assert.deepEqual(args.filter((arg) => arg.startsWith('--')).sort(), ['--apply', '--manifest', '--now', '--out-dir', '--sample'])
  assert.equal(args[args.indexOf('--out-dir') + 1], 'src/data/v2-sample')
  assert.equal(args[args.indexOf('--manifest') + 1], `src/data/v2-sample/${V2_SAMPLE_MANIFEST_NAME}`)
  const legacyTravelSample = JSON.parse(readFileSync(path.join(webRoot, 'src', 'data', 'travel-map.sample.json'), 'utf8'))
  assert.equal(legacyTravelSample.generated_at, '2026-08-12')
  assert.equal(args[args.indexOf('--now') + 1], new Date(legacyTravelSample.generated_at).toISOString())
})

test('sample:v2 可复现：同一条命令（输出目录与清单换到只放了已提交清单的临时目录）写出的五个文件与已提交文件逐字节相同，清单不变', () => withTemp(async (directory) => {
  const out = path.join(directory, 'v2-sample')
  await mkdir(out)
  await cp(path.join(V2_SAMPLE_DIRECTORY, V2_SAMPLE_MANIFEST_NAME), path.join(out, V2_SAMPLE_MANIFEST_NAME))
  const privateRoot = path.join(directory, 'private')
  const args = replaceValue(replaceValue(sampleV2Args(), '--out-dir', out), '--manifest', path.join(out, V2_SAMPLE_MANIFEST_NAME))

  const result = runMigrate(args, privateRoot)
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.doesNotMatch(result.stdout, /I_MANIFEST_ALLOCATED/, '清单里已有全部 UUID，不再分配')
  assert.deepEqual((await readdir(out)).sort(), [...V2_SAMPLE_ALLOWED_FILES], '只有六个文件，没有 .bak 或临时文件')
  for (const name of V2_SAMPLE_ALLOWED_FILES) {
    const committed = await readFile(path.join(V2_SAMPLE_DIRECTORY, name))
    const generated = await readFile(path.join(out, name))
    assert.ok(generated.equals(committed), `${name} 与已提交文件逐字节不同`)
  }
  assert.equal(existsSync(privateRoot), false, '--sample 不碰私人根')
}))

test('sample:v2 的空目录规则：输出目录里除了本次的清单还有别的（例如清单的 .bak）→ 拒绝（退出码 2），什么都不写', () => withTemp(async (directory) => {
  const out = path.join(directory, 'v2-sample')
  await mkdir(out)
  const manifest = path.join(out, V2_SAMPLE_MANIFEST_NAME)
  await cp(path.join(V2_SAMPLE_DIRECTORY, V2_SAMPLE_MANIFEST_NAME), manifest)
  await writeFile(path.join(out, 'identity-manifest.bak'), '{}', 'utf8')
  const args = replaceValue(replaceValue(sampleV2Args(), '--out-dir', out), '--manifest', manifest)
  const result = runMigrate(args, path.join(directory, 'private'))
  assert.equal(result.status, 2, result.stdout)
  assert.match(result.stdout, /不是空目录/)
  assert.deepEqual((await readdir(out)).sort(), ['identity-manifest.bak', V2_SAMPLE_MANIFEST_NAME])
}))

test('隐私门：--sample 只额外放行 src/data/v2-sample/ 本身；它的子目录、仓库里的其他目录照旧拒绝', () => withTemp(async (directory) => {
  const privateRoot = path.join(directory, 'private')
  assert.equal(isV2SampleDirectory(V2_SAMPLE_DIRECTORY), true)
  assert.equal(isV2SampleDirectory(path.join(webRoot, 'src', 'data', 'v2-sample', '.')), true)
  assert.equal(isV2SampleDirectory(path.join(V2_SAMPLE_DIRECTORY, 'sub')), false)
  assert.equal(isV2SampleDirectory(path.join(webRoot, 'src', 'data')), false)

  // 已提交的目录本身：只因「不是空目录」被拒，而不是隐私门（不写任何文件）。
  const itself = runMigrate(['--sample', '--apply', '--out-dir', V2_SAMPLE_DIRECTORY], privateRoot)
  assert.equal(itself.status, 2)
  assert.match(itself.stdout, /不是空目录/)
  assert.doesNotMatch(itself.stdout, /位于 Git 仓库/)

  for (const target of [path.join(V2_SAMPLE_DIRECTORY, 'sub'), path.join(webRoot, 'src', 'data', 'v2-sample-copy')]) {
    const refused = runMigrate(['--sample', '--apply', '--out-dir', target], privateRoot)
    assert.equal(refused.status, 2, target)
    assert.match(refused.stdout, /位于 Git 仓库/)
    assert.equal(existsSync(target), false)
  }
  assert.deepEqual((await readdir(V2_SAMPLE_DIRECTORY)).sort(), [...V2_SAMPLE_ALLOWED_FILES])
}))

// ---------------------------------------------------------------------------
// 已提交文件
// ---------------------------------------------------------------------------

test('已提交的 V2 样例：五个文件通过 validateV2Files；目录里只有六个文件；隐私审计通过', () => {
  const files = readV2SampleFiles()
  assert.ok(V2_FILE_KEYS.every((key) => files[key] !== undefined))
  assert.deepEqual(validateV2Files(files), [])
  assert.deepEqual(readdirSync(V2_SAMPLE_DIRECTORY).sort(), [...V2_SAMPLE_ALLOWED_FILES])
  assert.deepEqual(auditV2SampleDirectory(), [])
})

test('shadow compare 在已提交文件上成立：V2 样例（来源 sample）经 V2 Reader 派生，映射回旧 id 后与旧样例的 A′ 逐字节相同；与 A 只差 schemaVersion', () => {
  const read = (name) => JSON.parse(readFileSync(path.join(webRoot, 'src', 'data', name), 'utf8'))
  const manifest = parseIdentityManifest(JSON.parse(readFileSync(path.join(V2_SAMPLE_DIRECTORY, V2_SAMPLE_MANIFEST_NAME), 'utf8')))
  const now = manifest.plannedAt
  // 与 migrate-identity --sample 读旧样例的方式相同（公开模式语义）。
  const raw = {
    travelMap: read('travel-map.sample.json'),
    travelAtlasDataSource: 'sample',
    editorState: undefined,
    mediaCatalog: undefined,
    wantToGo: { source: 'sample', value: read('want-to-go.sample.json') },
    now,
  }
  const plan = planMigration({
    raw,
    fileMeta: fileMetaFromRaw(raw),
    manifest,
    sourceHash: manifest.sourceHash,
    newId: () => { throw new Error('已提交的清单应当覆盖全部地点，不应分配新 UUID') },
    now,
  })
  assert.equal(plan.report.canApply, true)
  const { legacy, applied, oldIdOf } = plan.canonical

  // App 在公开模式下的输入（src/data/rawInputs.ts）：已提交的五个文件，来源 sample。
  const v2Sample = canonicalForInputs({ dataMode: 'v2', v2Files: readV2SampleFiles(), source: 'sample' })
  assert.equal(v2Sample.travel.source, 'sample')
  assert.equal(v2Sample.wantToGo.source, 'sample')

  // 派生层：不借 L′ 的运行时字段，直接比——来源参数让 travelAtlasDataSource / wantToGoDataSource 本来就是 sample。
  const aPrime = baselineOf(applied)
  const b = mapUuidsBack(baselineOf(v2Sample), oldIdOf)
  assert.equal(stableStringify(b), stableStringify(aPrime))

  // 两层 shadow compare（PR3a 的同一个函数）。
  const result = shadowCompare({ expected: applied, actual: v2Sample, oldIdOf })
  assert.deepEqual(result.canonical, { equal: true, total: 0, paths: [] })
  assert.deepEqual(result.derived, { equal: true, total: 0, paths: [] })

  // A（今天的公开页面：旧样例经 Legacy Adapter）与 B 的差异，就是迁移报告里 A 与 A′ 的那一处。
  const diff = compareBaselines(baselineOf(legacy), b)
  assert.deepEqual(diff.paths, ['$.modules.travelAtlas.travelAtlasMeta.schemaVersion'])
})

test('canonicalForInputs 的来源参数：缺省为 local（与 PR3b 相同），sample 只改 travel.source 与 wantToGo.source', () => {
  const files = readV2SampleFiles()
  const local = canonicalForInputs({ dataMode: 'v2', v2Files: files })
  const explicitLocal = canonicalForInputs({ dataMode: 'v2', v2Files: files, source: 'local' })
  const sample = canonicalForInputs({ dataMode: 'v2', v2Files: files, source: 'sample' })
  assert.equal(local.travel.source, 'local')
  assert.equal(local.wantToGo.source, 'local')
  assert.deepEqual(explicitLocal, local)
  assert.deepEqual(
    { ...sample, travel: { ...sample.travel, source: 'local' }, wantToGo: { ...sample.wantToGo, source: 'local' } },
    local,
  )
  const empty = canonicalForInputs({ dataMode: 'v2', v2Files: undefined, source: 'sample' })
  assert.equal(empty.travel.source, 'sample')
  assert.equal(empty.places.length, 0)
})

test('App 接线：rawInputs.ts 静态 import 五个 V2 样例文件（文件名同 V2_SAMPLE_FILE_NAMES），不再 import 旧的想去样例', () => {
  const source = readFileSync(path.join(webRoot, 'src', 'data', 'rawInputs.ts'), 'utf8')
  for (const name of Object.values(V2_SAMPLE_FILE_NAMES)) {
    assert.match(source, new RegExp(`^import \\w+ from './v2-sample/${name.replace('.', '\\.')}'$`, 'm'), name)
  }
  assert.doesNotMatch(source, /want-to-go\.sample\.json/)
  assert.match(source, /\{ dataMode: 'v2', v2Files: v2SampleFiles, source: 'sample' \}/)
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
