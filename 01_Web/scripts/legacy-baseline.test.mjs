/**
 * scripts/legacy-baseline.mjs 的测试（RFC-LOC-1 PR1 §3.3、§3.5）。
 *
 * 运行方式：npm test（node --test 同时覆盖 src/**\/*.test.ts 与 scripts/**\/*.test.mjs）。
 * 零依赖：只用 node:test + node:assert/strict + node:fs + node:child_process。
 *
 * 每次启动 CLI 都把 STARMAP_PRIVATE_ROOT 指向本测试用 fs.mkdtemp 建的临时目录，
 * 绝不读作者的真实私有层；用例结束时删除临时目录。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { deriveAppData } from '../src/data/derive/appData.ts'
import { buildBaseline, stableStringify } from '../src/data/derive/baseline.ts'

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cliPath = path.join(webRoot, 'scripts', 'legacy-baseline.mjs')
const NOW = '2000-01-01T00:00:00.000Z'
/** PR1 公布的公开样例基线哈希；PR2 的新路径必须产出同一份。 */
const SAMPLE_BASELINE_SHA256 = 'eb91f172531f7c87280b07399af6ee80d1fc6e99a2ad38efa50b60b9afd299a4'

const readSample = (name) => JSON.parse(readFileSync(path.join(webRoot, 'src', 'data', name), 'utf8'))

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

const runCli = (args, privateRoot, nodeArgs = []) => spawnSync(process.execPath, [...nodeArgs, cliPath, ...args], {
  cwd: webRoot,
  env: { ...process.env, STARMAP_PRIVATE_ROOT: privateRoot },
  encoding: 'utf8',
})

const writePrivate = (root, name, content) =>
  writeFile(path.join(root, 'data', name), typeof content === 'string' ? content : JSON.stringify(content), 'utf8')

const readBaseline = async (filePath) => JSON.parse(await readFile(filePath, 'utf8'))

// ---------------------------------------------------------------------------
// --sample
// ---------------------------------------------------------------------------

test('--sample 两次输出逐字节相同，末尾换行，内容等于 deriveAppData 的公开模式基线', () => withTemp(async ({ root, out }) => {
  const first = path.join(out, 'a.json')
  const second = path.join(out, 'b.json')
  const runFirst = runCli(['--sample', '--out', first], root)
  assert.equal(runFirst.status, 0, runFirst.stderr)
  assert.equal(runCli(['--out', second, '--sample'], root).status, 0)

  const text = await readFile(first, 'utf8')
  assert.equal(text, await readFile(second, 'utf8'))
  assert.ok(text.endsWith('}\n'))
  assert.match(runFirst.stdout, /已写入 .*a\.json（\d+ 字节，sha256 [0-9a-f]{64}）/)

  const expected = stableStringify(buildBaseline(deriveAppData({
    travelMap: readSample('travel-map.sample.json'),
    travelAtlasDataSource: 'sample',
    editorState: undefined,
    mediaCatalog: undefined,
    wantToGo: { source: 'sample', value: readSample('want-to-go.sample.json') },
    now: NOW,
  }), { now: NOW }))
  assert.equal(text, `${expected}\n`)
}))

test('--sample 不读私有层：私有文件损坏也不影响', () => withTemp(async ({ root, out }) => {
  await writePrivate(root, 'travel-map.local.json', '{ broken')
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
  baseline.modules.travelAtlas.cities[1].lat = 1.5
  baseline.modules.travelAtlas.countryById['faroe-islands'].nameEn = 'Changed'
  const second = path.join(out, 'b.json')
  await writeFile(second, `${stableStringify(baseline)}\n`, 'utf8')

  const different = runCli(['--compare', first, second], root)
  assert.equal(different.status, 1)
  assert.match(different.stdout, /共 2 处差异/)
  assert.match(different.stdout, /^ {2}\$\.modules\.travelAtlas\.cities\[1\]\.lat$/m)
  assert.match(different.stdout, /^ {2}\$\.modules\.travelAtlas\.countryById\["faroe-islands"\]\.nameEn$/m)
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
// 个人模式
// ---------------------------------------------------------------------------

test('隐私门：个人模式 --out 在仓库之内被拒（退出码 2），不写文件', () => withTemp(async ({ root }) => {
  await writePrivate(root, 'travel-map.local.json', readSample('travel-map.sample.json'))
  const inside = [
    path.join(webRoot, 'legacy-baseline-should-not-exist.json'),
    path.join(webRoot, '..', 'nested', 'legacy-baseline-should-not-exist.json'),
    path.join(webRoot, '..'),
  ]
  if (process.platform === 'win32') inside.push(path.join(webRoot.toUpperCase(), 'legacy-baseline-should-not-exist.json'))

  for (const target of inside) {
    const result = runCli(['--out', target], root)
    assert.equal(result.status, 2, `${target}\n${result.stderr}`)
    assert.match(result.stderr, /拒绝写入/)
  }
  assert.equal(existsSync(inside[0]), false)
  assert.equal(existsSync(path.dirname(inside[1])), false)
}))

test('隐私门：私人根在仓库内（独立克隆的 06_private）时，写到私人根之内放行；写到仓库内其他位置仍被拒（退出码 2）', () => withPrivateRootInsideRepo(async ({ root }) => {
  await writePrivate(root, 'travel-map.local.json', readSample('travel-map.sample.json'))
  const inside = path.join(root, 'baseline', 'a.json')
  const allowed = runCli(['--out', inside], root)
  assert.equal(allowed.status, 0, allowed.stderr)
  assert.ok(existsSync(inside))
  const verify = runCli(['--verify', '--out-dir', path.join(root, 'verify')], root)
  assert.equal(verify.status, 0, verify.stderr)
  assert.ok(existsSync(path.join(root, 'verify', 'c.json')))

  for (const target of [path.join(webRoot, 'legacy-baseline-should-not-exist.json'), path.join(webRoot, '..', 'legacy-baseline-should-not-exist.json')]) {
    const refused = runCli(['--out', target], root)
    assert.equal(refused.status, 2, `${target}
${refused.stderr}`)
    assert.match(refused.stderr, /拒绝写入/)
    assert.equal(existsSync(target), false)
  }
}))

test('个人模式：先报出实际使用的私人根目录', () => withTemp(async ({ root, out }) => {
  const result = runCli(['--out', path.join(out, 'a.json')], root)
  assert.equal(result.status, 0, result.stderr)
  assert.ok(result.stderr.includes(`私人根目录：${path.resolve(root)}`), result.stderr)
}))

test('个人模式：私有文件都不存在 → 足迹回落样例，想去为 none，editor-state 与媒体为空', () => withTemp(async ({ root, out }) => {
  const target = path.join(out, 'a.json')
  assert.equal(runCli(['--out', target], root).status, 0)
  const { modules } = await readBaseline(target)
  assert.equal(modules.travelAtlas.travelAtlasDataSource, 'sample')
  assert.equal(modules.travelAtlas.cities.length, 5)
  assert.equal(modules.wantToGo.wantToGoDataSource, 'none')
  assert.deepEqual(modules.wantToGo.wantToGoItems, [])
  assert.deepEqual(modules.editorState.travelAtlasEditorState.hiddenCityIds, [])
  assert.deepEqual(modules.mediaCatalog.allImportedMediaItems, [])
}))

test('个人模式：有效的私有文件被使用，结果等于 deriveAppData 对同一份原始值的基线', () => withTemp(async ({ root, out }) => {
  const travel = readSample('travel-map.sample.json')
  travel.privacy_level = 'local-only'
  const want = readSample('want-to-go.sample.json')
  want.items[0].hidden = true
  const editorState = { schemaVersion: 1, hiddenCityIds: ['iceland__vik'], countryOrder: ['faroe-islands'] }
  const mediaCatalog = { schemaVersion: 2, items: [] }
  await writePrivate(root, 'travel-map.local.json', travel)
  await writePrivate(root, 'want-to-go.local.json', want)
  await writePrivate(root, 'editor-state.local.json', editorState)
  await writePrivate(root, 'user-media.local.json', mediaCatalog)

  const target = path.join(out, 'a.json')
  assert.equal(runCli(['--out', target], root).status, 0)
  const text = await readFile(target, 'utf8')
  const { modules } = JSON.parse(text)
  assert.equal(modules.travelAtlas.travelAtlasDataSource, 'local')
  assert.equal(modules.wantToGo.wantToGoDataSource, 'local')
  assert.deepEqual(modules.travelAtlas.cities.map((city) => city.id).includes('iceland__vik'), false)
  assert.deepEqual(modules.travelAtlas.countries.map((country) => country.id), ['faroe-islands', 'iceland'])
  assert.equal(modules.wantToGo.hiddenWantToGoItems.length, 1)

  const expected = stableStringify(buildBaseline(deriveAppData({
    travelMap: travel,
    travelAtlasDataSource: 'local',
    editorState,
    mediaCatalog,
    wantToGo: { source: 'local', value: want },
    now: NOW,
  }), { now: NOW }))
  assert.equal(text, `${expected}\n`)
}))

test('个人模式：足迹私有文件没有 records 数组 → 回落样例；想去文件内容为 null → none', () => withTemp(async ({ root, out }) => {
  await writePrivate(root, 'travel-map.local.json', { schema_version: 1, records: 'nope' })
  await writePrivate(root, 'want-to-go.local.json', 'null')
  const target = path.join(out, 'a.json')
  assert.equal(runCli(['--out', target], root).status, 0)
  const { modules } = await readBaseline(target)
  assert.equal(modules.travelAtlas.travelAtlasDataSource, 'sample')
  assert.equal(modules.wantToGo.wantToGoDataSource, 'none')
}))

test('个人模式：想去文件存在但内容无效 → local，坏数据进 problems（与 App 一致，不回落）', () => withTemp(async ({ root, out }) => {
  await writePrivate(root, 'want-to-go.local.json', { schema_version: 2, items: [] })
  const target = path.join(out, 'a.json')
  assert.equal(runCli(['--out', target], root).status, 0)
  const { modules } = await readBaseline(target)
  assert.equal(modules.wantToGo.wantToGoDataSource, 'local')
  assert.equal(modules.wantToGo.wantToGoProblems.length, 1)
}))

test('个人模式：私有文件不是有效 JSON → 退出码 1，只报路径不报内容', () => withTemp(async ({ root, out }) => {
  await writePrivate(root, 'editor-state.local.json', '{ "secretPlace": oops }')
  const target = path.join(out, 'a.json')
  const result = runCli(['--out', target], root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /读取失败：.*editor-state\.local\.json（不是有效的 JSON）/)
  assert.doesNotMatch(result.stderr, /secretPlace|oops/)
  assert.equal(existsSync(target), false)
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

// ---------------------------------------------------------------------------
// RFC-LOC-1 PR2：--path / --normalize / --verify
// ---------------------------------------------------------------------------

const sha256 = (text) => createHash('sha256').update(text).digest('hex')

/** 公开样例 + 两条写法不一致的记录（城市英文名大小写、国家代码不同）。 */
const inconsistentTravelMap = () => {
  const travel = readSample('travel-map.sample.json')
  travel.privacy_level = 'local-only'
  travel.records.push(
    { ...travel.records[0], id: 'case_variant', city_en: 'reykjavik', trip_title: undefined, start_date: '2025-06-09' },
    { ...travel.records[3], id: 'code_variant', country_code: 'dk', start_date: '2025-06-10' },
  )
  return travel
}

test('--sample --path canonical：新路径的输出等于 PR1 公布的公开样例基线', () => withTemp(async ({ root, out }) => {
  const canonical = path.join(out, 'canonical.json')
  const legacy = path.join(out, 'legacy.json')
  const normalized = path.join(out, 'normalized.json')
  assert.equal(runCli(['--sample', '--path', 'canonical', '--out', canonical], root).status, 0)
  assert.equal(runCli(['--sample', '--path', 'legacy', '--out', legacy], root).status, 0)
  assert.equal(runCli(['--sample', '--normalize', '--out', normalized], root).status, 0)

  const text = await readFile(canonical, 'utf8')
  assert.equal(sha256(text), SAMPLE_BASELINE_SHA256)
  assert.equal(await readFile(legacy, 'utf8'), text)
  assert.equal(await readFile(normalized, 'utf8'), text)
}))

test('--verify --sample：报告全为 0，A、B、C 逐字节相同，退出码 0，不写文件', () => withTemp(async ({ root, out }) => {
  const result = runCli(['--verify', '--sample'], root)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /国家中文名不一致（按国家计）：0/)
  assert.doesNotMatch(result.stdout, /：[1-9]\d*$/m)
  assert.equal(result.stdout.match(new RegExp(`sha256 ${SAMPLE_BASELINE_SHA256}`, 'g'))?.length, 3)
  assert.match(result.stdout, /A 与 B（写法统一带来的变化，只报告）：逐字节相同。/)
  assert.match(result.stdout, /B 与 C（适配器与派生的正确性，必须相同）：逐字节相同。/)
  assert.match(result.stdout, /通过：B ≡ C。/)
  assert.doesNotMatch(result.stdout, /已写入/)
  assert.deepEqual(await readdir(out), [])
}))

test('--verify 个人模式：写法不一致时报告计数与记录 id（--details），列出 A 与 B 的差异路径，B ≡ C 退出码 0', () => withTemp(async ({ root, out }) => {
  await writePrivate(root, 'travel-map.local.json', inconsistentTravelMap())
  const plain = runCli(['--verify'], root)
  assert.equal(plain.status, 0, plain.stderr)
  assert.ok(plain.stderr.includes(`私人根目录：${path.resolve(root)}`), plain.stderr)
  assert.match(plain.stdout, /城市英文名不一致（按城市计）：1/)
  assert.match(plain.stdout, /国家代码冲突：同一国家的记录写了不同的代码（按国家计）：1/)
  assert.doesNotMatch(plain.stdout, /case_variant|code_variant/)
  assert.match(plain.stdout, /A 与 B（写法统一带来的变化，只报告）：共 \d+ 处差异/)
  assert.match(plain.stdout, /^ {2}\$\.modules\.travelAtlas\.journeyDays\[5\]\.title$/m)
  assert.match(plain.stdout, /B 与 C（适配器与派生的正确性，必须相同）：逐字节相同。/)

  const detailed = runCli(['--verify', '--details', '--out-dir', path.join(out, 'verify')], root)
  assert.equal(detailed.status, 0, detailed.stderr)
  assert.match(detailed.stdout, /^ {4}case_variant$/m)
  assert.match(detailed.stdout, /^ {4}code_variant$/m)
  const [a, b, c] = await Promise.all(['a.json', 'b.json', 'c.json'].map((name) => readFile(path.join(out, 'verify', name), 'utf8')))
  assert.notEqual(a, b)
  assert.equal(b, c)
  assert.ok(c.endsWith('}\n'))
}))

test('--verify：B 与 C 不同（测试内替换新路径的派生函数）时退出码 1，并列出差异路径', () => withTemp(async ({ root, out }) => {
  // 只在这次启动的 CLI 进程里生效：加载 canonical/derive.ts 时在模块末尾把导出的派生函数包一层，改掉一个字段。
  const hookPath = path.join(out, 'break-canonical-derive.mjs')
  await writeFile(hookPath, [
    "import { registerHooks } from 'node:module'",
    "const patch = '\\n;{ const original = deriveAppDataFromCanonical; deriveAppDataFromCanonical = (canonical, options) => { const data = original(canonical, options); data.travelAtlas.travelAtlasMeta = { ...data.travelAtlas.travelAtlasMeta, totalRecords: -1 }; return data } }\\n'",
    'registerHooks({',
    '  load(url, context, nextLoad) {',
    '    const result = nextLoad(url, context)',
    "    if (!url.endsWith('/src/data/canonical/derive.ts')) return result",
    "    const source = typeof result.source === 'string' ? result.source : new TextDecoder().decode(result.source)",
    '    return { ...result, source: source + patch }',
    '  },',
    '})',
  ].join('\n'), 'utf8')

  const result = runCli(['--verify', '--sample'], root, ['--import', pathToFileURL(hookPath).href])
  assert.equal(result.status, 1, result.stderr)
  assert.match(result.stdout, /B 与 C（适配器与派生的正确性，必须相同）：共 1 处差异/)
  assert.match(result.stdout, /^ {2}\$\.modules\.travelAtlas\.travelAtlasMeta\.totalRecords$/m)
  assert.match(result.stdout, /失败：B 与 C 不同。/)

  // 同一个钩子下，只要不走新路径，旧路径的输出不受影响。
  const legacy = path.join(out, 'legacy.json')
  assert.equal(runCli(['--sample', '--out', legacy], root, ['--import', pathToFileURL(hookPath).href]).status, 0)
  assert.equal(sha256(await readFile(legacy, 'utf8')), SAMPLE_BASELINE_SHA256)
}))

test('隐私门：个人模式 --verify --out-dir 在仓库之内被拒（退出码 2）；--sample 不限制写到哪里', () => withTemp(async ({ root, out }) => {
  await writePrivate(root, 'travel-map.local.json', inconsistentTravelMap())
  const inside = path.join(webRoot, 'legacy-baseline-should-not-exist')
  const result = runCli(['--verify', '--out-dir', inside], root)
  assert.equal(result.status, 2, result.stderr)
  assert.match(result.stderr, /拒绝写入/)
  assert.equal(existsSync(inside), false)

  const canonical = runCli(['--path', 'canonical', '--out', path.join(webRoot, 'legacy-baseline-should-not-exist.json')], root)
  assert.equal(canonical.status, 2)
  assert.equal(existsSync(path.join(webRoot, 'legacy-baseline-should-not-exist.json')), false)

  assert.equal(runCli(['--verify', '--sample', '--out-dir', path.join(out, 'sample-verify')], root).status, 0)
}))

test('PR2 参数错误退出码 1', () => withTemp(async ({ root, out }) => {
  const target = path.join(out, 'x.json')
  for (const args of [
    ['--sample', '--path', 'v2', '--out', target],
    ['--sample', '--path', '--out', target],
    ['--sample', '--path', 'canonical', '--normalize', '--out', target],
    ['--verify', '--sample', '--out', target],
    ['--verify', '--sample', '--path', 'canonical'],
    ['--verify', '--sample', '--normalize'],
    ['--verify', '--verify', '--sample'],
    ['--sample', '--details', '--out', target],
    ['--sample', '--out-dir', out, '--out', target],
    ['--verify', '--sample', '--out-dir'],
  ]) {
    const result = runCli(args, root)
    assert.equal(result.status, 1, `${args.join(' ')}\n${result.stderr}`)
    assert.match(result.stderr, /用法/)
  }
}))
