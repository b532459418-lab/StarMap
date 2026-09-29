/**
 * scripts/data-mode.mjs 的测试（RFC-LOC-1 PR3b-1 规格 §2.1、§2.3、§3），以及两个脚本在 V2 数据模式下的行为：
 * import-media 改由 V2 导入器运行（PR3b-3），migrate-identity --apply 拒绝。
 *
 * 运行方式：npm test。零依赖：只用 node:test + node:assert/strict + node:fs + node:child_process。
 * 私人根一律是本测试用 fs.mkdtemp 建的临时目录（STARMAP_PRIVATE_ROOT），绝不读作者的真实私有层；用例结束时删除。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  assertDataModeMarkerWritable,
  DataModeMarkerError,
  DataModeMarkerWriteRefused,
  FRESH_PROFILE_MODE,
  parseDataModeMarker,
  resolveDataMode,
  writeDataModeMarker,
} from './data-mode.mjs'
import { getPrivatePaths, V2_DATA_FILE_NAMES } from './private-profile.mjs'
import { V2_FILE_NAMES } from '../src/data/canonical/v2Schema.ts'

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const withPrivateRoot = async (run) => {
  const root = await mkdtemp(path.join(tmpdir(), 'starmap-data-mode-test-'))
  try {
    await mkdir(path.join(root, 'data'), { recursive: true })
    await run({ root, paths: getPrivatePaths({ STARMAP_PRIVATE_ROOT: root }) })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const writeMarker = (paths, content) => writeFile(paths.dataModePath, content, 'utf8')

// ---------------------------------------------------------------------------
// 路径与判定
// ---------------------------------------------------------------------------

test('getPrivatePaths：数据模式标记在 data/ 下，V2 文件在 data/v2/ 下，文件名与 v2Schema.ts 的 V2_FILE_NAMES 相同', () => {
  const root = path.join(tmpdir(), 'starmap-paths-only')
  const paths = getPrivatePaths({ STARMAP_PRIVATE_ROOT: root })
  assert.equal(paths.dataModePath, path.join(root, 'data', 'data-mode.local.json'))
  assert.equal(paths.v2DataRoot, path.join(root, 'data', 'v2'))
  assert.deepEqual(V2_DATA_FILE_NAMES, V2_FILE_NAMES)
  assert.deepEqual(
    paths.v2FilePaths,
    Object.fromEntries(Object.entries(V2_FILE_NAMES).map(([key, name]) => [key, path.join(root, 'data', 'v2', name)])),
  )
})

test('标记为 legacy / v2：按标记（reason: marker），即使同时有旧数据或什么都没有', () => withPrivateRoot(async ({ paths }) => {
  await writeMarker(paths, '{ "mode": "v2" }\n')
  assert.deepEqual(resolveDataMode(paths), { mode: 'v2', reason: 'marker' })
  await writeFile(paths.localTravelMapPath, '{"records":[]}', 'utf8')
  assert.deepEqual(resolveDataMode(paths), { mode: 'v2', reason: 'marker' })
  await writeMarker(paths, JSON.stringify({ mode: 'legacy' }))
  assert.deepEqual(resolveDataMode(paths), { mode: 'legacy', reason: 'marker' })
  assert.deepEqual(resolveDataMode(paths, { freshProfileMode: 'v2' }), { mode: 'legacy', reason: 'marker' })
}))

test('标记格式错误时抛错：非 JSON、不是对象、缺 mode、未知值（含大小写不同）、多余字段；错误写出文件路径与期望格式，不带原文', () => {
  const filePath = path.join(tmpdir(), 'x', 'data', 'data-mode.local.json')
  for (const [text, problem] of [
    ['', /不是有效的 JSON/],
    ['mode: v2', /不是有效的 JSON/],
    ['"v2"', /不是 JSON 对象/],
    ['["v2"]', /不是 JSON 对象/],
    ['null', /不是 JSON 对象/],
    ['{}', /缺少 mode 字段/],
    ['{ "mode": "V2" }', /mode 不是 legacy 或 v2/],
    ['{ "mode": "v3" }', /mode 不是 legacy 或 v2/],
    ['{ "mode": null }', /mode 不是 legacy 或 v2/],
    ['{ "mode": "v2", "since": "2026-09-27" }', /有多余的字段/],
  ]) {
    assert.throws(() => parseDataModeMarker(text, filePath), (error) => {
      assert.ok(error instanceof DataModeMarkerError, text)
      assert.match(error.message, problem, text)
      assert.ok(error.message.includes(filePath), text)
      assert.ok(error.message.includes('{ "mode": "legacy" } 或 { "mode": "v2" }'), text)
      assert.ok(!error.message.includes('2026-09-27'), '错误信息不带原文')
      return true
    })
  }
  assert.equal(parseDataModeMarker('{"mode":"legacy"}', filePath), 'legacy')
  assert.equal(parseDataModeMarker('\n  { "mode" : "v2" }\n', filePath), 'v2')
})

test('标记文件开头的一个 UTF-8 BOM 被容忍：带 BOM 的 { "mode": "v2" } 判为 v2；BOM 之后内容非法照样报错；只去一个', () => withPrivateRoot(async ({ paths }) => {
  const filePath = paths.dataModePath
  assert.equal(parseDataModeMarker('\uFEFF{ "mode": "v2" }', filePath), 'v2')
  assert.equal(parseDataModeMarker('\uFEFF{"mode":"legacy"}\r\n', filePath), 'legacy')
  for (const [text, problem] of [
    ['\uFEFF{ "mode": "V2" }', /mode 不是 legacy 或 v2/],
    ['\uFEFF{ "mode": "v2", "extra": 1 }', /有多余的字段/],
    ['\uFEFF{}', /缺少 mode 字段/],
    ['\uFEFF', /不是有效的 JSON/],
    ['\uFEFF\uFEFF{ "mode": "v2" }', /不是有效的 JSON/],
    ['{ "mode": "v2" }\uFEFF', /不是有效的 JSON/],
  ]) {
    assert.throws(() => parseDataModeMarker(text, filePath), (error) => error instanceof DataModeMarkerError && problem.test(error.message), JSON.stringify(text))
  }

  // 磁盘上的真实字节：Windows 工具写出的 EF BB BF + JSON。
  await writeFile(filePath, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{ "mode": "v2" }\r\n', 'utf8')]))
  assert.deepEqual(resolveDataMode(paths), { mode: 'v2', reason: 'marker' })
  await writeFile(filePath, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{ "mode": "V2" }', 'utf8')]))
  assert.throws(() => resolveDataMode(paths), DataModeMarkerError)
}))

test('防回退：data-mode.mjs 的源码里没有字面 U+FEFF，BOM 用转义写法（字面字符一旦被编辑器去掉，就成了 startsWith(\'\')）', () => {
  const source = readFileSync(path.join(webRoot, 'scripts', 'data-mode.mjs'), 'utf8')
  const bom = String.fromCharCode(0xfeff)
  assert.equal(source.includes(bom), false, 'scripts/data-mode.mjs 含有字面 U+FEFF')
  // 转义写法（反斜杠 + uFEFF）在源码里：解析器确实去的是 BOM。这里也不写字面反斜杠序列，免得本文件自己带上字面字符。
  assert.ok(source.includes(`startsWith('${String.fromCharCode(92)}uFEFF')`), '没有找到 BOM 的转义写法')
  assert.equal(source.includes("startsWith('')"), false)
})

test('resolveDataMode：标记文件损坏时抛 DataModeMarkerError（不按任何模式静默运行）', () => withPrivateRoot(async ({ paths }) => {
  await writeMarker(paths, '{ "mode": "V2" }')
  assert.throws(() => resolveDataMode(paths), DataModeMarkerError)
  await rm(paths.dataModePath)
  await mkdir(paths.dataModePath)
  assert.throws(() => resolveDataMode(paths), /读取失败/)
}))

test('没有标记、有任一旧数据文件 → legacy（reason: legacy-data）', () => withPrivateRoot(async ({ paths }) => {
  for (const key of ['localTravelMapPath', 'wantToGoPath', 'editorStatePath', 'mediaCatalogPath']) {
    await writeFile(paths[key], '{}', 'utf8')
    assert.deepEqual(resolveDataMode(paths), { mode: 'legacy', reason: 'legacy-data' }, key)
    assert.deepEqual(resolveDataMode(paths, { freshProfileMode: 'v2' }), { mode: 'legacy', reason: 'legacy-data' }, key)
    await rm(paths[key])
  }
  // data/v2/ 里的文件、迁移清单都不算旧数据。
  await mkdir(paths.v2DataRoot, { recursive: true })
  await writeFile(paths.v2FilePaths.travel, '{}', 'utf8')
  assert.deepEqual(resolveDataMode(paths), { mode: FRESH_PROFILE_MODE, reason: 'fresh-profile' })
}))

test('全新目录：默认参数下为 v2（PR4 把 FRESH_PROFILE_MODE 改为 v2，决定 C）；freshProfileMode: legacy 时为 legacy', () => withPrivateRoot(async ({ root, paths }) => {
  assert.equal(FRESH_PROFILE_MODE, 'v2')
  assert.deepEqual(resolveDataMode(paths), { mode: 'v2', reason: 'fresh-profile' })
  assert.deepEqual(resolveDataMode(paths, { freshProfileMode: 'legacy' }), { mode: 'legacy', reason: 'fresh-profile' })
  assert.throws(() => resolveDataMode(paths, { freshProfileMode: 'V2' }), TypeError)
  // 私人根下连 data/ 都没有也一样。
  await rm(path.join(root, 'data'), { recursive: true })
  assert.deepEqual(resolveDataMode(paths), { mode: 'v2', reason: 'fresh-profile' })
}))

test('默认判定的三步（PR4）：全新目录 v2；有旧数据 legacy；标记优先于两者', () => withPrivateRoot(async ({ paths }) => {
  assert.deepEqual(resolveDataMode(paths), { mode: 'v2', reason: 'fresh-profile' })
  await writeFile(paths.wantToGoPath, '{"schema_version":1,"items":[]}', 'utf8')
  assert.deepEqual(resolveDataMode(paths), { mode: 'legacy', reason: 'legacy-data' })
  await writeMarker(paths, '{ "mode": "v2" }')
  assert.deepEqual(resolveDataMode(paths), { mode: 'v2', reason: 'marker' })
  await rm(paths.wantToGoPath)
  await writeMarker(paths, '{ "mode": "legacy" }')
  assert.deepEqual(resolveDataMode(paths), { mode: 'legacy', reason: 'marker' })
}))

test('每次现读，不缓存：标记改了，下一次判定就变', () => withPrivateRoot(async ({ paths }) => {
  assert.equal(resolveDataMode(paths).mode, 'v2')
  await writeMarker(paths, '{"mode":"legacy"}')
  assert.equal(resolveDataMode(paths).mode, 'legacy')
  await writeMarker(paths, '{"mode":"v2"}')
  assert.equal(resolveDataMode(paths).mode, 'v2')
  await writeMarker(paths, '{"mode":"legacy"}')
  assert.equal(resolveDataMode(paths).mode, 'legacy')
  await rm(paths.dataModePath)
  assert.deepEqual(resolveDataMode(paths), { mode: 'v2', reason: 'fresh-profile' })
}))

test('writeDataModeMarker：原子写入 { "mode": … }，结尾换行、不带 BOM（字节层）；已有标记时留 .bak；隐私门只放行私人根之内', () => withPrivateRoot(async ({ root, paths }) => {
  assert.equal(await writeDataModeMarker(paths, 'v2'), paths.dataModePath)
  const bytes = await readFile(paths.dataModePath)
  assert.deepEqual([...bytes.subarray(0, 3)], [...Buffer.from('{\n ', 'utf8')], '不以 BOM（EF BB BF）开头')
  assert.equal(bytes.toString('utf8'), '{\n  "mode": "v2"\n}\n')
  assert.deepEqual(resolveDataMode(paths), { mode: 'v2', reason: 'marker' })

  await writeDataModeMarker(paths, 'legacy')
  assert.equal(await readFile(paths.dataModePath, 'utf8'), '{\n  "mode": "legacy"\n}\n')
  assert.equal(await readFile(path.join(root, 'data', 'data-mode.local.bak'), 'utf8'), '{\n  "mode": "v2"\n}\n', '上一版留作 .bak')
  assert.deepEqual(resolveDataMode(paths), { mode: 'legacy', reason: 'marker' })
  assert.deepEqual((await readdir(path.join(root, 'data'))).sort(), ['data-mode.local.bak', 'data-mode.local.json'], '没有留下临时文件')

  await assert.rejects(writeDataModeMarker(paths, 'V2'), TypeError)
  // 标记路径不在私人根之内（手工拼出的错误 paths），或私人根就是仓库：都拒绝，不写。
  const outside = { ...paths, dataModePath: path.join(tmpdir(), 'starmap-not-private', 'data-mode.local.json') }
  await assert.rejects(writeDataModeMarker(outside, 'v2'), DataModeMarkerWriteRefused)
  assert.equal(existsSync(outside.dataModePath), false)
  const repoPaths = getPrivatePaths({ STARMAP_PRIVATE_ROOT: path.resolve(webRoot, '..') })
  assert.throws(() => assertDataModeMarkerWritable(repoPaths), DataModeMarkerWriteRefused)
  await assert.rejects(writeDataModeMarker(repoPaths, 'v2'), DataModeMarkerWriteRefused)
  assert.equal(existsSync(repoPaths.dataModePath), false)
}))

// ---------------------------------------------------------------------------
// 脚本：V2 模式下拒绝（退出码 2）；标记损坏时报错（退出码 1）
// ---------------------------------------------------------------------------

const runScript = (script, args, privateRoot) => spawnSync(process.execPath, [path.join(webRoot, 'scripts', script), ...args], {
  cwd: webRoot,
  env: { ...process.env, STARMAP_PRIVATE_ROOT: privateRoot },
  encoding: 'utf8',
})

const readSample = (name) => JSON.parse(readFileSync(path.join(webRoot, 'src', 'data', name), 'utf8'))

/** 私人根下全部文件（相对路径 → sha256），用来证明被拒绝时什么都没写。 */
const snapshotTree = async (root) => {
  const result = {}
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name)
      if (entry.isDirectory()) await walk(full)
      else result[path.relative(root, full)] = createHash('sha256').update(await readFile(full)).digest('hex')
    }
  }
  await walk(root)
  return result
}

test('import-media：V2 模式下改由 V2 导入器运行（PR3b-3 去掉了 PR3b-1 的拒绝），不读旧足迹文件，有错误时不写任何文件；标记损坏时报错（退出码 1）', () => withPrivateRoot(async ({ root, paths }) => {
  await writeFile(paths.localTravelMapPath, JSON.stringify(readSample('travel-map.sample.json')), 'utf8')
  await writeMarker(paths, '{ "mode": "v2" }')
  const before = await snapshotTree(root)
  for (const args of [[], ['--apply']]) {
    const result = runScript('import-media.mjs', args, root)
    assert.equal(result.status, 1, `${args.join(' ')}\n${result.stderr}`)
    assert.match(result.stdout, /（V2 数据模式）：0 个文件/)
    assert.match(result.stderr, /需要处理（1）[\s\S]*找不到外置私有层的 MediaInbox/)
    assert.doesNotMatch(result.stdout, /预检通过/)
  }
  assert.deepEqual(await snapshotTree(root), before)
  assert.equal(existsSync(path.join(root, 'MediaInbox')), false)

  await writeMarker(paths, '{ "mode": "V2" }')
  const broken = runScript('import-media.mjs', [], root)
  assert.equal(broken.status, 1, broken.stderr)
  assert.match(broken.stderr, /数据模式标记文件 .*data-mode\.local\.json mode 不是 legacy 或 v2/)
  assert.doesNotMatch(broken.stderr, /\n\s+at /, '只报消息，不打印调用栈')

  // legacy 模式照旧：私人目录没有 MediaInbox → 预检报错（退出码 1），不是被数据模式拦下。
  await writeMarker(paths, '{ "mode": "legacy" }')
  const legacy = runScript('import-media.mjs', [], root)
  assert.equal(legacy.status, 1)
  assert.match(legacy.stderr, /找不到外置私有层的 MediaInbox/)
  assert.doesNotMatch(legacy.stderr, /V2 数据模式/)
}))

test('migrate-identity：V2 模式下 --apply 拒绝（退出码 2，不写任何文件），dry-run 仍可运行；标记损坏时 --apply 报错（退出码 1）', () => withPrivateRoot(async ({ root, paths }) => {
  await writeFile(paths.localTravelMapPath, JSON.stringify(readSample('travel-map.sample.json')), 'utf8')
  await writeFile(paths.wantToGoPath, JSON.stringify(readSample('want-to-go.sample.json')), 'utf8')
  // 先在 legacy 模式下 dry-run → --apply，生成 data/v2/（正在使用的数据），再切到 v2。
  assert.equal(runScript('migrate-identity.mjs', [], root).status, 0)
  const applied = runScript('migrate-identity.mjs', ['--apply'], root)
  assert.equal(applied.status, 0, applied.stdout + applied.stderr)
  await writeMarker(paths, '{ "mode": "v2" }')
  const v2Before = await snapshotTree(paths.v2DataRoot)

  // 输出目录另给一个空目录也不行：V2 模式下 --apply 一律拒绝。
  for (const args of [['--apply'], ['--apply', '--out-dir', path.join(root, 'elsewhere')]]) {
    const before = await snapshotTree(root)
    const result = runScript('migrate-identity.mjs', args, root)
    assert.equal(result.status, 2, `${args.join(' ')}\n${result.stdout}${result.stderr}`)
    assert.match(result.stderr, /V2 数据模式.*--apply 不能运行/)
    assert.equal(result.stdout, '', '在读取任何私人文件之前拒绝')
    assert.deepEqual(await snapshotTree(root), before)
  }
  assert.deepEqual(await snapshotTree(paths.v2DataRoot), v2Before)

  const dryRun = runScript('migrate-identity.mjs', [], root)
  assert.equal(dryRun.status, 0, dryRun.stderr)
  assert.match(dryRun.stdout, /canApply：/)

  await writeMarker(paths, '{ "mode": "v2", "extra": true }')
  const broken = runScript('migrate-identity.mjs', ['--apply'], root)
  assert.equal(broken.status, 1, broken.stderr)
  assert.match(broken.stderr, /数据模式标记文件 .*data-mode\.local\.json 有多余的字段/)
  assert.deepEqual(await snapshotTree(paths.v2DataRoot), v2Before)
}))
