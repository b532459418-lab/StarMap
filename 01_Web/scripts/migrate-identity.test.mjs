/**
 * scripts/migrate-identity.mjs 的测试（RFC-LOC-1 PR3a 规格 §3、§4）。
 *
 * 运行方式：npm test（node --test 同时覆盖 src/**\/*.test.ts 与 scripts/**\/*.test.mjs）。
 * 零依赖：只用 node:test + node:assert/strict + node:fs + node:child_process。
 *
 * 每次启动 CLI 都把 STARMAP_PRIVATE_ROOT 指向本测试用 fs.mkdtemp 建的临时目录，
 * 绝不读作者的真实私有层；用例结束时删除临时目录。私人数据全是中性样例数据。
 * 每个个人模式用例结束前都核对四个旧文件逐字节未变。
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

import { isUuidV7 } from '../src/data/canonical/uuidv7.ts'
import { V2_FILE_KEYS, V2_FILE_NAMES, validateV2Files } from '../src/data/canonical/v2Schema.ts'

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cliPath = path.join(webRoot, 'scripts', 'migrate-identity.mjs')

const LEGACY_FILES = ['travel-map.local.json', 'want-to-go.local.json', 'editor-state.local.json', 'user-media.local.json']

const readSample = (name) => JSON.parse(readFileSync(path.join(webRoot, 'src', 'data', name), 'utf8'))

/** 临时目录：root 充当 STARMAP_PRIVATE_ROOT，out 放输出。 */
const withTemp = async (run) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'starmap-migrate-test-'))
  const root = path.join(directory, 'private')
  const out = path.join(directory, 'out')
  await mkdir(path.join(root, 'data'), { recursive: true })
  await mkdir(out, { recursive: true })
  try {
    await run({ root, out, data: path.join(root, 'data') })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

/**
 * 私人根放在仓库里（模拟独立克隆的 06_private/）：建在已被 .gitignore 覆盖的 node_modules 下，
 * 清理失败也不会弄脏工作区；绝不碰仓库里真实的 06_private/。
 */
const withPrivateRootInsideRepo = async (run) => {
  const root = await mkdtemp(path.join(webRoot, 'node_modules', '.starmap-private-root-test-'))
  try {
    await mkdir(path.join(root, 'data'), { recursive: true })
    await run({ root })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const runCli = (args, privateRoot) => spawnSync(process.execPath, [cliPath, ...args], {
  cwd: webRoot,
  env: { ...process.env, STARMAP_PRIVATE_ROOT: privateRoot },
  encoding: 'utf8',
})

const writePrivate = (root, name, content) =>
  writeFile(path.join(root, 'data', name), typeof content === 'string' ? content : JSON.stringify(content, null, 2), 'utf8')

/** 四个旧文件的字节哈希（不存在为 null）。 */
const legacySnapshot = async (root) => Object.fromEntries(await Promise.all(LEGACY_FILES.map(async (name) => {
  const filePath = path.join(root, 'data', name)
  return [name, existsSync(filePath) ? createHash('sha256').update(await readFile(filePath)).digest('hex') : null]
})))

/** 中性的个人模式旧数据：公开样例的足迹与想去（一条隐藏），editor-state 与媒体各几条。 */
const writeLegacyData = async (root) => {
  const travel = readSample('travel-map.sample.json')
  travel.privacy_level = 'local-only'
  const want = readSample('want-to-go.sample.json')
  want.items[0].hidden = true
  await writePrivate(root, 'travel-map.local.json', travel)
  await writePrivate(root, 'want-to-go.local.json', want)
  await writePrivate(root, 'editor-state.local.json', {
    schemaVersion: 1,
    countryOrder: ['faroe-islands', 'iceland'],
    hiddenCityIds: ['iceland__vik'],
    coverMediaByCity: { iceland__reykjavik: 'photo-1' },
  })
  await writePrivate(root, 'user-media.local.json', {
    schemaVersion: 2,
    generatedAt: '2026-09-01T00:00:00.000Z',
    privacyLevel: 'local-only',
    items: [{
      id: 'photo-1', kind: 'photo', scope: 'city', countryId: 'iceland', countryName: 'Iceland', cityId: 'iceland__reykjavik', cityName: 'Reykjavik',
      src: '/media/user/sample/photo-1.jpg', originalFileName: 'photo-1.jpg', isCover: false, status: 'ready', titleEn: 'Harbour',
    }],
  })
}

/** 想去里加一条与足迹「维克」合并键相同、中文名不同的条目 → 需确认 nameDifference。 */
const addPendingNameDifference = async (root) => {
  const want = JSON.parse(await readFile(path.join(root, 'data', 'want-to-go.local.json'), 'utf8'))
  want.items.push({ id: 'wtg_vik', place: { kind: 'city', nameZh: '维克镇', nameEn: 'Vik', countryCode: 'IS', lat: 63.4186, lng: -19.006 }, addedAt: '2026-09-01', hidden: false })
  await writePrivate(root, 'want-to-go.local.json', want)
}

const readJson = async (filePath) => JSON.parse(await readFile(filePath, 'utf8'))

const manifestPath = (root) => path.join(root, 'data', 'migration', 'identity-manifest.local.json')

const assertV2Files = async (directory) => {
  assert.deepEqual((await readdir(directory)).sort(), Object.values(V2_FILE_NAMES).sort())
  const files = Object.fromEntries(await Promise.all(V2_FILE_KEYS.map(async (key) => [key, await readJson(path.join(directory, V2_FILE_NAMES[key]))])))
  assert.deepEqual(validateV2Files(files), [])
  return files
}

// ---------------------------------------------------------------------------
// --sample
// ---------------------------------------------------------------------------

test('--sample：退出码 0，摘要含 canApply，不写任何文件，也不读私有层', () => withTemp(async ({ root, out }) => {
  await writePrivate(root, 'travel-map.local.json', '{ broken')
  const result = runCli(['--sample'], root)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /^canApply：true$/m)
  assert.match(result.stdout, /派生层（A′ 与 B 逐字节相同）：通过。/)
  assert.match(result.stdout, /A 与 A′（合并与决定带来的显示变化，只报告）：共 1 处差异/)
  assert.match(result.stdout, /^ {2}\$\.modules\.travelAtlas\.travelAtlasMeta\.schemaVersion$/m)
  assert.doesNotMatch(result.stdout, /iceland__reykjavik/, '不加 --details 不列地点旧 id')
  assert.doesNotMatch(result.stderr, /私人根目录/)
  assert.deepEqual(await readdir(out), [])
  assert.deepEqual(await readdir(root), ['data'])
  assert.deepEqual(await readdir(path.join(root, 'data')), ['travel-map.local.json'])
}))

test('--sample --details：列出地点旧 id → 新 id，不打印名称与坐标', () => withTemp(async ({ root }) => {
  const result = runCli(['--sample', '--details'], root)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /^ {2}城市 {2}iceland__reykjavik → [0-9a-f-]{36}（新分配）$/m)
  assert.match(result.stdout, /^ {6}wtg:wtg_2026-08-12_akureyri → iceland__akureyri$/m)
  assert.doesNotMatch(result.stdout, /Reykjavik|雷克雅未克|64\.1466/)
}))

test('--sample --apply --out-dir：写出五个文件，都通过校验；地点 11 个；不写数据模式标记', () => withTemp(async ({ root, out }) => {
  const target = path.join(out, 'v2')
  const result = runCli(['--sample', '--apply', '--out-dir', target], root)
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, /五个文件从磁盘读回后都通过 V2 校验（地点 11 个）/)
  const files = await assertV2Files(target)
  assert.equal(files.places.places.length, 11)
  assert.ok(files.places.places.every((place) => isUuidV7(place.id)))
  assert.equal(files.travel.schema_version, 2)
  assert.equal(files.wantToGo.privacy_level, 'public-sample')
  assert.equal(existsSync(path.join(root, 'data', 'data-mode.local.json')), false)
  assert.deepEqual(await readdir(path.join(root, 'data')), [])
}))

test('--sample --apply：输出目录非空、在仓库之内被拒（退出码 2）；没给 --out-dir 是参数错误', () => withTemp(async ({ root, out }) => {
  await writeFile(path.join(out, 'keep.txt'), 'x')
  const nonEmpty = runCli(['--sample', '--apply', '--out-dir', out], root)
  assert.equal(nonEmpty.status, 2)
  assert.match(nonEmpty.stdout, /不是空目录/)
  assert.deepEqual(await readdir(out), ['keep.txt'])

  const inside = path.join(webRoot, 'migrate-identity-should-not-exist')
  const insideResult = runCli(['--sample', '--apply', '--out-dir', inside], root)
  assert.equal(insideResult.status, 2)
  assert.match(insideResult.stdout, /位于 Git 仓库/)
  assert.equal(existsSync(inside), false)

  const missing = runCli(['--sample', '--apply'], root)
  assert.equal(missing.status, 1)
  assert.match(missing.stderr, /用法/)
}))

// ---------------------------------------------------------------------------
// 个人模式
// ---------------------------------------------------------------------------

test('个人模式：空私人目录 → 无需迁移，退出码 0，不写任何文件；先报出私人根目录', () => withTemp(async ({ root }) => {
  const result = runCli([], root)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /私人目录没有旧数据，无需迁移。/)
  assert.ok(result.stderr.includes(`私人根目录：${path.resolve(root)}`), result.stderr)
  assert.deepEqual(await readdir(path.join(root, 'data')), [])
}))

test('个人模式：dry-run 写迁移清单（记录旧文件哈希）；两次 dry-run 的 UUID 相同；旧文件不变', () => withTemp(async ({ root }) => {
  await writeLegacyData(root)
  const before = await legacySnapshot(root)

  const first = runCli([], root)
  assert.equal(first.status, 0, first.stderr)
  assert.match(first.stdout, /^canApply：true$/m)
  assert.match(first.stdout, /已写回迁移清单/)
  const manifest = await readJson(manifestPath(root))
  assert.equal(manifest.schema_version, 1)
  assert.match(manifest.sourceHash, /^[0-9a-f]{64}$/)
  assert.equal(first.stdout.match(/旧文件哈希：([0-9a-f]{64})/)[1], manifest.sourceHash)
  assert.equal(Object.keys(manifest.sources).length, 11)
  assert.ok(Object.values(manifest.sources).every(isUuidV7))

  const second = runCli([], root)
  assert.equal(second.status, 0, second.stderr)
  assert.deepEqual((await readJson(manifestPath(root))).sources, manifest.sources)
  assert.doesNotMatch(second.stdout, /I_MANIFEST_ALLOCATED/)
  assert.equal(existsSync(path.join(root, 'data', 'v2')), false)
  assert.deepEqual(await legacySnapshot(root), before)
}))

test('个人模式 --apply：dry-run 之后写出到 data/v2/，使用清单里的 UUID；不写数据模式标记；旧文件不变', () => withTemp(async ({ root }) => {
  await writeLegacyData(root)
  const before = await legacySnapshot(root)
  assert.equal(runCli([], root).status, 0)
  const manifest = await readJson(manifestPath(root))

  const result = runCli(['--apply', '--details'], root)
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  const files = await assertV2Files(path.join(root, 'data', 'v2'))
  assert.deepEqual(files.places.places.map((place) => place.id).sort(), Object.values(manifest.sources).sort())
  assert.equal(files.media.generatedAt, '2026-09-01T00:00:00.000Z')
  assert.equal(files.media.items[0].placeId, manifest.sources['city:iceland__reykjavik'])
  assert.deepEqual(files.editorState.hiddenCityIds, [manifest.sources['city:iceland__vik']])
  assert.deepEqual(await readJson(manifestPath(root)), manifest)
  assert.equal(existsSync(path.join(root, 'data', 'data-mode.local.json')), false)
  assert.deepEqual(await legacySnapshot(root), before)

  // 再 apply 一次：输出目录已非空，被拒。
  const again = runCli(['--apply'], root)
  assert.equal(again.status, 2)
  assert.match(again.stdout, /不是空目录/)
}))

test('个人模式 --apply：没有 dry-run 过、或数据在 dry-run 之后变了 → 被拒（退出码 2），什么都不写', () => withTemp(async ({ root }) => {
  await writeLegacyData(root)
  const never = runCli(['--apply'], root)
  assert.equal(never.status, 2)
  assert.match(never.stdout, /请先 dry-run/)
  assert.equal(existsSync(path.join(root, 'data', 'migration')), false)

  assert.equal(runCli([], root).status, 0)
  const manifest = await readJson(manifestPath(root))
  const travel = await readJson(path.join(root, 'data', 'travel-map.local.json'))
  travel.records[0].notes = 'Edited after the dry run.'
  await writePrivate(root, 'travel-map.local.json', travel)
  const before = await legacySnapshot(root)

  const changed = runCli(['--apply'], root)
  assert.equal(changed.status, 2)
  assert.match(changed.stdout, /请先重新 dry-run/)
  assert.equal(existsSync(path.join(root, 'data', 'v2')), false)
  assert.deepEqual(await readJson(manifestPath(root)), manifest)
  assert.deepEqual(await legacySnapshot(root), before)
}))

test('个人模式 --apply：有未决定项时被拒；写进决定文件后通过', () => withTemp(async ({ root }) => {
  await writeLegacyData(root)
  await addPendingNameDifference(root)
  const before = await legacySnapshot(root)

  const dryRun = runCli([], root)
  assert.equal(dryRun.status, 0)
  assert.match(dryRun.stdout, /^canApply：false（1 项待决定）$/m)
  assert.match(dryRun.stdout, /\[nameDifference\] nameDifferences\["wtg:wtg_vik"\] {2}未决定（可选：accept）/)
  assert.doesNotMatch(dryRun.stdout, /维克镇/)

  const refused = runCli(['--apply'], root)
  assert.equal(refused.status, 2)
  assert.match(refused.stdout, /canApply 为 false/)
  assert.equal(existsSync(path.join(root, 'data', 'v2')), false)

  await mkdir(path.join(root, 'data', 'migration'), { recursive: true })
  await writeFile(path.join(root, 'data', 'migration', 'identity-decisions.local.json'), JSON.stringify({ schema_version: 1, nameDifferences: { 'wtg:wtg_vik': 'accept' } }))
  const accepted = runCli(['--apply'], root)
  assert.equal(accepted.status, 0, `${accepted.stdout}\n${accepted.stderr}`)
  await assertV2Files(path.join(root, 'data', 'v2'))
  assert.deepEqual(await legacySnapshot(root), before)
}))

test('隐私门：个人模式 --out-dir 或 --report 在仓库之内被拒（退出码 2），在读取私人文件之前', () => withTemp(async ({ root }) => {
  await writeLegacyData(root)
  await writePrivate(root, 'editor-state.local.json', '{ broken')
  const before = await legacySnapshot(root)
  for (const args of [
    ['--out-dir', path.join(webRoot, 'migrate-identity-should-not-exist')],
    ['--apply', '--out-dir', path.join(webRoot, '..', 'migrate-identity-should-not-exist')],
    ['--report', path.join(webRoot, 'migrate-identity-should-not-exist.json')],
  ]) {
    const result = runCli(args, root)
    assert.equal(result.status, 2, `${args.join(' ')}\n${result.stderr}`)
    assert.match(result.stderr, /拒绝写入/)
    assert.doesNotMatch(result.stderr, /不是有效的 JSON/)
  }
  assert.equal(existsSync(path.join(webRoot, 'migrate-identity-should-not-exist')), false)
  assert.equal(existsSync(path.join(webRoot, 'migrate-identity-should-not-exist.json')), false)
  assert.equal(existsSync(path.join(root, 'data', 'migration')), false)
  assert.deepEqual(await legacySnapshot(root), before)
}))

test('隐私门：私人根在仓库内（独立克隆的 06_private）时，私人根之内的 --report 与默认 data/v2 放行；写到仓库内其他位置仍被拒（退出码 2）', () => withPrivateRootInsideRepo(async ({ root }) => {
  await writeLegacyData(root)
  const before = await legacySnapshot(root)
  const reportPath = path.join(root, 'reports', 'migration.json')
  const dryRun = runCli(['--report', reportPath], root)
  assert.equal(dryRun.status, 0, dryRun.stderr)
  assert.ok(existsSync(reportPath))
  assert.ok(existsSync(manifestPath(root)))

  const applied = runCli(['--apply'], root)
  assert.equal(applied.status, 0, `${applied.stdout}
${applied.stderr}`)
  await assertV2Files(path.join(root, 'data', 'v2'))

  for (const args of [
    ['--out-dir', path.join(webRoot, 'migrate-identity-should-not-exist')],
    ['--report', path.join(webRoot, '..', 'migrate-identity-should-not-exist.json')],
    ['--apply', '--out-dir', path.join(webRoot, 'migrate-identity-should-not-exist')],
  ]) {
    const refused = runCli(args, root)
    assert.equal(refused.status, 2, `${args.join(' ')}
${refused.stderr}`)
    assert.match(refused.stderr, /拒绝写入/)
  }
  assert.equal(existsSync(path.join(webRoot, 'migrate-identity-should-not-exist')), false)
  assert.equal(existsSync(path.join(webRoot, '..', 'migrate-identity-should-not-exist.json')), false)
  assert.deepEqual(await legacySnapshot(root), before)
}))

test('个人模式：--report 写出完整报告（含待决项两边的名称，只在报告里）；只缺几个旧文件按空处理', () => withTemp(async ({ root, out }) => {
  await writePrivate(root, 'want-to-go.local.json', readSample('want-to-go.sample.json'))
  const reportPath = path.join(out, 'report.json')
  const result = runCli(['--report', reportPath], root)
  assert.equal(result.status, 0, result.stderr)
  const report = await readJson(reportPath)
  assert.equal(report.canApply, true)
  assert.equal(report.counts.before.records, 0)
  assert.deepEqual(report.places.map((place) => place.oldId), ['iso:GL', 'wtg:wtg_2026-08-12_nuuk', 'iso:NO', 'wtg:wtg_2026-08-12_tromso', 'iso:IS', 'wtg:wtg_2026-08-12_akureyri'])
  assert.equal(report.places[0].names.en, 'Greenland')
}))

test('个人模式：旧文件不是有效 JSON、足迹文件没有 records、清单或决定文件不合法 → 退出码 1，只报路径不报内容', () => withTemp(async ({ root }) => {
  await writePrivate(root, 'editor-state.local.json', '{ "secretPlace": oops }')
  const invalid = runCli([], root)
  assert.equal(invalid.status, 1)
  assert.match(invalid.stderr, /读取失败：.*editor-state\.local\.json（不是有效的 JSON）/)
  assert.doesNotMatch(invalid.stderr, /secretPlace|oops/)

  await writePrivate(root, 'editor-state.local.json', { schemaVersion: 1 })
  await writePrivate(root, 'travel-map.local.json', { schema_version: 1, records: 'nope' })
  const noRecords = runCli([], root)
  assert.equal(noRecords.status, 1)
  assert.match(noRecords.stderr, /没有 records 数组/)

  await writeLegacyData(root)
  await mkdir(path.join(root, 'data', 'migration'), { recursive: true })
  await writeFile(manifestPath(root), JSON.stringify({ schema_version: 1, sources: { 'city:secret__place': 'nope' } }))
  const badManifest = runCli([], root)
  assert.equal(badManifest.status, 1)
  assert.match(badManifest.stderr, /identity-manifest\.local\.json（迁移清单 sources 的第 1 项不是小写的 UUIDv7。）/)
  assert.doesNotMatch(badManifest.stderr, /secret/)

  await rm(manifestPath(root))
  const decisionsPath = path.join(root, 'data', 'migration', 'identity-decisions.local.json')
  await writeFile(decisionsPath, JSON.stringify({ schema_version: 1, nameDifferences: { 'wtg:x': 'reject' } }))
  assert.equal(runCli([], root).status, 1)
  assert.equal(runCli(['--decisions', path.join(root, 'missing.json')], root).status, 1)
}))

test('旧位置出现 V2 版本的文件：dry-run 报 E_MIXED_VERSIONS（退出码 0），--apply 被拒', () => withTemp(async ({ root }) => {
  await writeLegacyData(root)
  await writePrivate(root, 'editor-state.local.json', { schemaVersion: 2, addedCountries: [] })
  const result = runCli([], root)
  assert.equal(result.status, 0)
  assert.match(result.stdout, /\[E_MIXED_VERSIONS\]/)
  assert.match(result.stdout, /^canApply：false/m)
  assert.equal(runCli(['--apply'], root).status, 2)
}))

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------

test('参数错误退出码 1', () => withTemp(async ({ root }) => {
  for (const args of [['--bogus'], ['--sample', '--sample'], ['--out-dir'], ['--report', '--sample'], ['--manifest'], ['--sample', '--apply']]) {
    const result = runCli(args, root)
    assert.equal(result.status, 1, `${args.join(' ')}\n${result.stderr}`)
    assert.match(result.stderr, /用法/)
  }
}))
