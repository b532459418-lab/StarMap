/**
 * scripts/baseline.mjs 的测试（RFC-LOC-1 PR1 §3.3、§3.5；PR5b §4.2：由 legacy-baseline.test.mjs 改名，只留 V2 的两种输入）。
 *
 * 运行方式：npm test（node --test 同时覆盖 src/**\/*.test.ts 与 scripts/**\/*.test.mjs）。
 * 零依赖：只用 node:test + node:assert/strict + node:fs + node:child_process。
 *
 * 每次启动 CLI 都把 STARMAP_PRIVATE_ROOT 指向本测试用 fs.mkdtemp 建的临时目录，
 * 绝不读作者的真实私有层；用例结束时删除临时目录。个人模式的 V2 文件是冻结的中性数据（./fixtures/baseline-v2.json）。
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

import { readV2SampleFiles } from './v2-sample.mjs'
import { canonicalForInputs } from '../src/data/canonical/canonicalForInputs.ts'
import { deriveAppDataFromCanonical } from '../src/data/canonical/derive.ts'
import { V2_FILE_KEYS, V2_FILE_NAMES } from '../src/data/canonical/v2Schema.ts'
import { buildBaseline, stableStringify } from '../src/data/derive/baseline.ts'

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cliPath = path.join(webRoot, 'scripts', 'baseline.mjs')
const NOW = '2000-01-01T00:00:00.000Z'
/** 公开 V2 样例的派生基线（RFC-LOC-1 PR4 起公布）。 */
const V2_SAMPLE_BASELINE_SHA256 = '8bce80df6abf01574cf90c3f5184fdcb036f4fe54aff3926ab20d8dc72424b15'

/** 临时目录：root 充当 STARMAP_PRIVATE_ROOT，out 放输出。 */
const withTemp = async (run) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'starmap-baseline-test-'))
  const root = path.join(directory, 'private')
  const out = path.join(directory, 'out')
  await mkdir(path.join(root, 'data'), { recursive: true })
  await mkdir(out, { recursive: true })
  try {
    await run({ root, out })
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

const v2FilePath = (root, key) => path.join(root, 'data', 'v2', V2_FILE_NAMES[key])

const readBaseline = async (filePath) => JSON.parse(await readFile(filePath, 'utf8'))

const sha256 = (text) => createHash('sha256').update(text).digest('hex')

/**
 * 临时私人根：data/v2/ 是中性旧数据（公开样例的足迹与想去，editor-state 隐藏一个城市、调换国家顺序）迁移后的五个文件
 * （冻结的 ./fixtures/baseline-v2.json；RFC-LOC-1 PR5b 之前由迁移工具现场生成）。
 */
const prepareV2Root = async (root) => {
  const files = JSON.parse(readFileSync(path.join(webRoot, 'scripts', 'fixtures', 'baseline-v2.json'), 'utf8'))
  await mkdir(path.join(root, 'data', 'v2'), { recursive: true })
  for (const key of V2_FILE_KEYS) await writeFile(v2FilePath(root, key), `${JSON.stringify(files[key], null, 2)}\n`, 'utf8')
}

const readV2FilesFrom = async (root) => Object.fromEntries(await Promise.all(V2_FILE_KEYS.map(async (key) => {
  const filePath = v2FilePath(root, key)
  return [key, existsSync(filePath) ? JSON.parse(await readFile(filePath, 'utf8')) : undefined]
})))

/** 与 App 相同的管线（canonicalForInputs → 派生 → 基线），在测试进程里算一遍。 */
const expectedBaseline = (inputs) =>
  `${stableStringify(buildBaseline(deriveAppDataFromCanonical(canonicalForInputs(inputs), { now: NOW }), { now: NOW }))}\n`

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

// ---------------------------------------------------------------------------
// --sample：公开 V2 样例
// ---------------------------------------------------------------------------

test('--sample：读已提交的 src/data/v2-sample/（来源 sample），两次输出逐字节相同、末尾换行，等于进程内的同一条管线，sha256 为公布的 8bce80df…', () => withTemp(async ({ root, out }) => {
  const first = path.join(out, 'a.json')
  const second = path.join(out, 'b.json')
  const runFirst = runCli(['--sample', '--out', first], root)
  assert.equal(runFirst.status, 0, runFirst.stderr)
  assert.doesNotMatch(runFirst.stderr, /私人根目录/, '公开模式语义：不报私人根，也不读私人文件')
  assert.equal(runCli(['--out', second, '--sample'], root).status, 0)

  const text = await readFile(first, 'utf8')
  assert.equal(text, await readFile(second, 'utf8'))
  assert.ok(text.endsWith('}\n'))
  assert.match(runFirst.stdout, /已写入 .*a\.json（\d+ 字节，sha256 [0-9a-f]{64}）/)
  assert.equal(text, expectedBaseline({ v2Files: readV2SampleFiles(), source: 'sample' }))
  assert.equal(sha256(text), V2_SAMPLE_BASELINE_SHA256)

  const baseline = JSON.parse(text)
  assert.deepEqual(Object.keys(baseline).sort(), ['format', 'modules', 'queries'], '基线里只有这三项，不含来源路径')
  assert.equal(baseline.modules.travelAtlas.travelAtlasDataSource, 'sample')
  assert.equal(baseline.modules.wantToGo.wantToGoDataSource, 'sample')
  assert.equal(baseline.modules.travelAtlas.cities.length, 5)
}))

test('--sample 不读私有层：私人目录的 V2 文件损坏也不影响', () => withTemp(async ({ root, out }) => {
  await mkdir(path.join(root, 'data', 'v2'), { recursive: true })
  await writeFile(v2FilePath(root, 'places'), '{ broken', 'utf8')
  const result = runCli(['--sample', '--out', path.join(out, 'a.json')], root)
  assert.equal(result.status, 0, result.stderr)
  assert.equal((await readBaseline(path.join(out, 'a.json'))).modules.travelAtlas.travelAtlasDataSource, 'sample')
}))

// ---------------------------------------------------------------------------
// --compare
// ---------------------------------------------------------------------------

test('--compare：相同为 0；不同为 1 并列出差异的 JSON 路径（不带值）', () => withTemp(async ({ root, out }) => {
  const first = path.join(out, 'a.json')
  assert.equal(runCli(['--sample', '--out', first], root).status, 0)

  const same = runCli(['--compare', first, first], root)
  assert.equal(same.status, 0)
  assert.match(same.stdout, /相同/)

  const baseline = await readBaseline(first)
  // 公开 V2 样例的国家 id 是 UUID（带连字符，路径里写成 ["…"]）。
  const faroe = Object.keys(baseline.modules.travelAtlas.countryById).find((id) => baseline.modules.travelAtlas.countryById[id].nameEn === 'Faroe Islands')
  assert.ok(faroe)
  baseline.modules.travelAtlas.cities[1].lat = 1.5
  baseline.modules.travelAtlas.countryById[faroe].nameEn = 'Changed'
  const second = path.join(out, 'b.json')
  await writeFile(second, `${stableStringify(baseline)}\n`, 'utf8')

  const different = runCli(['--compare', first, second], root)
  assert.equal(different.status, 1)
  assert.match(different.stdout, /共 2 处差异/)
  assert.match(different.stdout, /^ {2}\$\.modules\.travelAtlas\.cities\[1\]\.lat$/m)
  assert.ok(different.stdout.split('\n').includes(`  $.modules.travelAtlas.countryById["${faroe}"].nameEn`), different.stdout)
  assert.doesNotMatch(different.stdout, /Changed/)
}))

test('--compare：整键缺失只算一处；超过 50 处只列前 50 处；只差格式时也算不同', () => withTemp(async ({ root, out }) => {
  const first = path.join(out, 'a.json')
  assert.equal(runCli(['--sample', '--out', first], root).status, 0)
  const baseline = await readBaseline(first)

  const many = path.join(out, 'many.json')
  await writeFile(many, `${stableStringify({ ...baseline, format: 'x', extra: Array.from({ length: 60 }, (_, index) => index) })}\n`)
  const manyResult = runCli(['--compare', first, many], root)
  assert.equal(manyResult.status, 1)
  assert.match(manyResult.stdout, /共 2 处差异/)

  const shifted = structuredClone(baseline)
  shifted.modules.travelAtlas.cities = shifted.modules.travelAtlas.cities.map((city) => ({ ...city, lat: 0, lng: 0, nameEn: '', nameZh: '' }))
  shifted.modules.travelAtlas.journeyDays = shifted.modules.travelAtlas.journeyDays.map((day) => ({ ...day, title: '', summary: '', date: '', cityId: '', countryId: '', journeyId: '', isHighlight: true }))
  shifted.modules.travelAtlas.routes = []
  const shiftedPath = path.join(out, 'shifted.json')
  await writeFile(shiftedPath, `${stableStringify(shifted)}\n`)
  const shiftedResult = runCli(['--compare', first, shiftedPath], root)
  assert.equal(shiftedResult.status, 1)
  assert.match(shiftedResult.stdout, /共 \d+ 处差异，以下是前 50 处/)
  assert.equal(shiftedResult.stdout.split('\n').filter((line) => line.startsWith('  $')).length, 50)

  const reformatted = path.join(out, 'reformatted.json')
  await writeFile(reformatted, JSON.stringify(baseline))
  const reformattedResult = runCli(['--compare', first, reformatted], root)
  assert.equal(reformattedResult.status, 1)
  assert.match(reformattedResult.stdout, /只有格式或换行不同/)
}))

test('--compare：文件读不到为 1', () => withTemp(async ({ root, out }) => {
  const result = runCli(['--compare', path.join(out, 'missing-a.json'), path.join(out, 'missing-b.json')], root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /读取失败：.*missing-a\.json（ENOENT）/)
}))

// ---------------------------------------------------------------------------
// 个人模式：私人目录 data/v2/
// ---------------------------------------------------------------------------

test('个人模式：读 data/v2/ 的五个文件 → V2 Reader → 派生 → 基线，等于同一份文件在 canonicalForInputs 管线上的结果；地点 id 是 UUID', () => withTemp(async ({ root, out }) => {
  await prepareV2Root(root)
  const target = path.join(out, 'v2.json')
  const result = runCli(['--out', target], root)
  assert.equal(result.status, 0, result.stderr)
  assert.ok(result.stderr.includes(`私人根目录：${path.resolve(root)}`), result.stderr)
  const text = await readFile(target, 'utf8')
  const v2Files = await readV2FilesFrom(root)
  assert.equal(text, expectedBaseline({ v2Files }))

  const { modules } = JSON.parse(text)
  assert.ok(modules.travelAtlas.cities.length > 0)
  assert.ok(modules.travelAtlas.cities.every((city) => UUID_V7.test(city.id) && UUID_V7.test(city.countryId)))
  assert.equal(modules.travelAtlas.travelAtlasDataSource, 'local')
  // 被隐藏的城市（维克）不在 cities 里，但 countryIdOfCity 的定义域里有它，答案是冰岛的 UUID。
  const iceland = v2Files.places.places.find((place) => place.externalIds?.iso3166Alpha2 === 'IS').id
  const [vik] = v2Files.editorState.hiddenCityIds
  assert.ok(UUID_V7.test(vik))
  assert.deepEqual(modules.travelAtlas.countryIdOfCity.find(([cityId]) => cityId === vik), [vik, iceland])
  assert.equal(modules.travelAtlas.cities.some((city) => city.id === vik), false)
}))

test('个人模式：缺的文件按空处理，data/v2/ 不存在时是空数据（不回落到样例）', () => withTemp(async ({ root, out }) => {
  await prepareV2Root(root)
  await rm(v2FilePath(root, 'media'))
  const withoutMedia = path.join(out, 'no-media.json')
  assert.equal(runCli(['--out', withoutMedia], root).status, 0)
  assert.equal(await readFile(withoutMedia, 'utf8'), expectedBaseline({ v2Files: await readV2FilesFrom(root) }))

  await rm(path.join(root, 'data', 'v2'), { recursive: true })
  const empty = path.join(out, 'empty.json')
  assert.equal(runCli(['--out', empty], root).status, 0)
  const text = await readFile(empty, 'utf8')
  assert.equal(text, expectedBaseline({ v2Files: undefined }))
  const { modules } = JSON.parse(text)
  assert.deepEqual([modules.travelAtlas.countries, modules.travelAtlas.cities, modules.wantToGo.wantToGoItems], [[], [], []])
  assert.equal(modules.travelAtlas.travelAtlasDataSource, 'local')
}))

test('个人模式：先报出实际使用的私人根目录', () => withTemp(async ({ root, out }) => {
  const result = runCli(['--out', path.join(out, 'a.json')], root)
  assert.equal(result.status, 0, result.stderr)
  assert.ok(result.stderr.includes(`私人根目录：${path.resolve(root)}`), result.stderr)
}))

test('个人模式：V2 文件不合法 → 退出码 1，只报文件、路径与问题，不带内容；不是有效 JSON 同样退出码 1，只报路径不报内容', () => withTemp(async ({ root, out }) => {
  await prepareV2Root(root)
  const placesPath = v2FilePath(root, 'places')
  const places = JSON.parse(await readFile(placesPath, 'utf8'))
  const secretName = places.places[0].names.en
  places.places[0].names = { en: secretName, '': 'x' }
  await writeFile(placesPath, JSON.stringify(places), 'utf8')
  const invalid = runCli(['--out', path.join(out, 'x.json')], root)
  assert.equal(invalid.status, 1, invalid.stderr)
  assert.match(invalid.stderr, /V2 数据文件没有通过校验/)
  assert.match(invalid.stderr, /data\/v2\/places\.local\.json \$\.places\[0\]\.names/)
  assert.ok(!invalid.stderr.includes(secretName))
  assert.doesNotMatch(invalid.stderr, /\n\s+at /)

  await writeFile(v2FilePath(root, 'editorState'), '{ "secretPlace": oops }', 'utf8')
  const unreadable = runCli(['--out', path.join(out, 'y.json')], root)
  assert.equal(unreadable.status, 1)
  assert.match(unreadable.stderr, /读取失败：.*editor-state\.local\.json（不是有效的 JSON）/)
  assert.doesNotMatch(unreadable.stderr, /secretPlace|oops/)
  assert.deepEqual(await readdir(out), [])
}))

test('隐私门：个人模式 --out 在仓库之内被拒（退出码 2），不写文件', () => withTemp(async ({ root }) => {
  await prepareV2Root(root)
  const inside = [
    path.join(webRoot, 'baseline-should-not-exist.json'),
    path.join(webRoot, '..', 'nested', 'baseline-should-not-exist.json'),
    path.join(webRoot, '..'),
  ]
  if (process.platform === 'win32') inside.push(path.join(webRoot.toUpperCase(), 'baseline-should-not-exist.json'))

  for (const target of inside) {
    const result = runCli(['--out', target], root)
    assert.equal(result.status, 2, `${target}\n${result.stderr}`)
    assert.match(result.stderr, /拒绝写入/)
  }
  assert.equal(existsSync(inside[0]), false)
  assert.equal(existsSync(path.dirname(inside[1])), false)
}))

test('隐私门：私人根在仓库内（独立克隆的 06_private）时，写到私人根之内放行；写到仓库内其他位置仍被拒（退出码 2）', () => withPrivateRootInsideRepo(async ({ root }) => {
  await prepareV2Root(root)
  const inside = path.join(root, 'baseline', 'a.json')
  const allowed = runCli(['--out', inside], root)
  assert.equal(allowed.status, 0, allowed.stderr)
  assert.ok(existsSync(inside))

  for (const target of [path.join(webRoot, 'baseline-should-not-exist.json'), path.join(webRoot, '..', 'baseline-should-not-exist.json')]) {
    const refused = runCli(['--out', target], root)
    assert.equal(refused.status, 2, `${target}\n${refused.stderr}`)
    assert.match(refused.stderr, /拒绝写入/)
    assert.equal(existsSync(target), false)
  }
}))

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------

test('参数错误退出码 1', () => withTemp(async ({ root, out }) => {
  for (const args of [[], ['--sample'], ['--out'], ['--sample', '--out', '--sample'], ['--bogus'], ['--compare', 'a'], ['--compare', 'a', 'b', 'c'], ['--sample', '--sample', '--out', path.join(out, 'x.json')]]) {
    const result = runCli(args, root)
    assert.equal(result.status, 1, `${args.join(' ')}\n${result.stderr}`)
    assert.match(result.stderr, /用法/)
  }
}))

test('PR5b 删除的参数（--path、--normalize、--verify、--details、--out-dir）都是参数错误（退出码 1），不写文件', () => withTemp(async ({ root, out }) => {
  const target = path.join(out, 'x.json')
  for (const args of [
    ['--sample', '--path', 'v2-sample', '--out', target],
    ['--path', 'v2', '--out', target],
    ['--path', 'legacy', '--out', target],
    ['--sample', '--normalize', '--out', target],
    ['--verify', '--sample'],
    ['--verify'],
    ['--sample', '--details', '--out', target],
    ['--sample', '--out-dir', out],
  ]) {
    const result = runCli(args, root)
    assert.equal(result.status, 1, `${args.join(' ')}\n${result.stderr}`)
    assert.match(result.stderr, /无法识别的参数：--(path|normalize|verify|details|out-dir)/)
    assert.match(result.stderr, /用法/)
  }
  assert.deepEqual(await readdir(out), [])
}))
