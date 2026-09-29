/**
 * scripts/data-mode-cli.mjs（`npm run data-mode`）的测试（RFC-LOC-1 PR4 规格 §2.2、§3）。
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

import { resolveDataMode } from './data-mode.mjs'
import { getPrivatePaths } from './private-profile.mjs'

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cliPath = path.join(webRoot, 'scripts', 'data-mode-cli.mjs')

const withPrivateRoot = async (run) => {
  const root = await mkdtemp(path.join(tmpdir(), 'starmap-data-mode-cli-test-'))
  try {
    await mkdir(path.join(root, 'data'), { recursive: true })
    await run({ root, paths: getPrivatePaths({ STARMAP_PRIVATE_ROOT: root }) })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const runCli = (args, root) => spawnSync(process.execPath, [cliPath, ...args], {
  cwd: webRoot,
  env: { ...process.env, STARMAP_PRIVATE_ROOT: root },
  encoding: 'utf8',
})

/** 私人根下全部文件（相对路径 → sha256），用来证明没写任何东西。 */
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

const writeLegacyTravel = (paths) => writeFile(paths.localTravelMapPath, '{"schema_version":1,"records":[]}', 'utf8')

const writeV2Places = async (paths) => {
  await mkdir(paths.v2DataRoot, { recursive: true })
  await writeFile(paths.v2FilePaths.places, '{"schema_version":1,"generated_at":"2026-09-29T00:00:00.000Z","places":[]}', 'utf8')
}

test('package.json：npm run data-mode 就是这个脚本', () => {
  const scripts = JSON.parse(readFileSync(path.join(webRoot, 'package.json'), 'utf8')).scripts
  assert.equal(scripts['data-mode'], 'node scripts/data-mode-cli.mjs')
})

test('status：三种判定原因（全新目录 / 有旧数据 / 标记），先在 stderr 报出私人根目录；什么都不写', () => withPrivateRoot(async ({ root, paths }) => {
  const fresh = runCli([], root)
  assert.equal(fresh.status, 0, fresh.stderr)
  assert.ok(fresh.stderr.includes(`[data-mode] 私人根目录：${path.resolve(root)}`), fresh.stderr)
  assert.match(fresh.stdout, /^当前数据模式：v2$/m)
  assert.match(fresh.stdout, /^判定原因：全新目录 → v2（/m)
  assert.match(fresh.stdout, /^旧格式数据文件：没有$/m)
  assert.deepEqual(runCli(['status'], root).stdout, fresh.stdout, '`status` 与不带参数相同')

  await writeLegacyTravel(paths)
  const before = await snapshotTree(root)
  const legacy = runCli([], root)
  assert.equal(legacy.status, 0, legacy.stderr)
  assert.match(legacy.stdout, /^当前数据模式：legacy$/m)
  assert.match(legacy.stdout, /^判定原因：有旧数据 → legacy（/m)
  assert.match(legacy.stdout, /^V2 数据文件（.*）：没有$/m)
  assert.match(legacy.stdout, /npm run identity:check -- --apply --switch/, '提示如何迁移')
  assert.deepEqual(await snapshotTree(root), before)

  await writeFile(paths.dataModePath, '{ "mode": "v2" }', 'utf8')
  const marker = runCli([], root)
  assert.equal(marker.status, 0, marker.stderr)
  assert.match(marker.stdout, /^当前数据模式：v2$/m)
  assert.match(marker.stdout, /^判定原因：标记 → v2（.*data-mode\.local\.json）$/m)
}))

test('legacy / v2：原子写入标记（字节层：无 BOM、结尾换行），判定随之改变；已经是这个值时不重写', () => withPrivateRoot(async ({ root, paths }) => {
  const toLegacy = runCli(['legacy'], root)
  assert.equal(toLegacy.status, 0, toLegacy.stderr)
  const bytes = await readFile(paths.dataModePath)
  assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], '不带 BOM')
  assert.equal(bytes.toString('utf8'), '{\n  "mode": "legacy"\n}\n')
  assert.match(toLegacy.stdout, /已写入 .*data-mode\.local\.json：\{ "mode": "legacy" \}（之前：v2，判定原因：全新目录）。/)
  assert.match(toLegacy.stdout, /切回 V2：npm run data-mode -- v2/)
  assert.deepEqual(resolveDataMode(paths), { mode: 'legacy', reason: 'marker' })

  const toV2 = runCli(['v2'], root)
  assert.equal(toV2.status, 0, toV2.stderr)
  assert.equal(await readFile(paths.dataModePath, 'utf8'), '{\n  "mode": "v2"\n}\n')
  assert.match(toV2.stdout, /回滚：npm run data-mode -- legacy/)
  assert.deepEqual(resolveDataMode(paths), { mode: 'v2', reason: 'marker' })

  const before = await snapshotTree(root)
  const again = runCli(['v2'], root)
  assert.equal(again.status, 0, again.stderr)
  assert.match(again.stdout, /标记已经是 \{ "mode": "v2" \}，未改动/)
  assert.deepEqual(await snapshotTree(root), before, '不重写，也不多出 .bak')
  assert.deepEqual((await readdir(path.join(root, 'data'))).sort(), ['data-mode.local.bak', 'data-mode.local.json'])
}))

test('v2 的防呆：有旧数据、data/v2/ 里没有任何 V2 文件 → 拒绝（退出码 2），提示先迁移，不写标记；有 V2 文件后放行', () => withPrivateRoot(async ({ root, paths }) => {
  await writeLegacyTravel(paths)
  const before = await snapshotTree(root)
  const refused = runCli(['v2'], root)
  assert.equal(refused.status, 2, refused.stderr)
  assert.match(refused.stderr, /拒绝切换到 v2：私人目录有旧数据，但 .* 里没有任何 V2 文件/)
  assert.match(refused.stderr, /npm run identity:check -- --apply --switch/)
  assert.equal(refused.stdout, '')
  assert.deepEqual(await snapshotTree(root), before)

  // 已经回滚到 legacy 的目录同样适用（标记存在也看数据）。
  await writeFile(paths.dataModePath, '{ "mode": "legacy" }', 'utf8')
  assert.equal(runCli(['v2'], root).status, 2)
  assert.equal(await readFile(paths.dataModePath, 'utf8'), '{ "mode": "legacy" }')

  await writeV2Places(paths)
  const allowed = runCli(['v2'], root)
  assert.equal(allowed.status, 0, allowed.stderr)
  assert.deepEqual(resolveDataMode(paths), { mode: 'v2', reason: 'marker' })

  // legacy 方向没有防呆：回滚总是允许。
  assert.equal(runCli(['legacy'], root).status, 0)
  assert.deepEqual(resolveDataMode(paths), { mode: 'legacy', reason: 'marker' })
}))

test('标记损坏：status、legacy、v2 都报错（退出码 1），写出文件路径与期望格式，不改标记', () => withPrivateRoot(async ({ root, paths }) => {
  await writeFile(paths.dataModePath, '{ "mode": "V2" }', 'utf8')
  const before = await snapshotTree(root)
  for (const args of [[], ['status'], ['legacy'], ['v2']]) {
    const result = runCli(args, root)
    assert.equal(result.status, 1, `${args.join(' ')}\n${result.stderr}`)
    assert.match(result.stderr, /数据模式标记文件 .*data-mode\.local\.json mode 不是 legacy 或 v2/)
    assert.match(result.stderr, /请修正或删除这个文件后重试/)
    assert.doesNotMatch(result.stderr, /\n\s+at /, '只报消息，不打印调用栈')
    assert.equal(result.stdout, '')
  }
  assert.deepEqual(await snapshotTree(root), before)
}))

test('参数错误：未知子命令、多余参数 → 退出码 1，打印用法，不写', () => withPrivateRoot(async ({ root }) => {
  for (const args of [['V2'], ['--apply'], ['legacy', 'v2'], ['status', 'x']]) {
    const result = runCli(args, root)
    assert.equal(result.status, 1, `${args.join(' ')}\n${result.stderr}`)
    assert.match(result.stderr, /用法/)
  }
  assert.equal(existsSync(path.join(root, 'data', 'data-mode.local.json')), false)
}))
