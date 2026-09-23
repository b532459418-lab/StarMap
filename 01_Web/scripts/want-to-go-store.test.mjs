/**
 * createWantToGoStore 的单元测试（PRD FR-WTG-2 / FR-WTG-5 / FR-WTG-6 / FR-WTG-8）。
 *
 * 运行方式：npm test（node --test 同时覆盖 src/**\/*.test.ts 与 scripts/**\/*.test.mjs）。
 * 零依赖：只用 node:test + node:assert/strict + node:fs。
 *
 * 每个用例都在 fs.mkdtemp 建的独立临时目录里跑，并注入固定的 now，
 * 这样 id、addedAt 与 generated_at 都是确定值，断言可以写死。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createWantToGoStore } from './want-to-go-store.mjs'

/** 固定时间：2026-09-17 本地时间，用来钉死 addedAt 与 generated_at。 */
const FIXED_NOW = new Date(2026, 8, 17, 10, 30, 0)
const FIXED_DATE = '2026-09-17'

const withStore = async (run) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'starmap-wtg-'))
  const filePath = path.join(directory, 'want-to-go.local.json')
  const store = createWantToGoStore({ filePath, now: () => FIXED_NOW })
  try {
    await run({ store, filePath, directory })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

const readRaw = async (filePath) => JSON.parse(await readFile(filePath, 'utf8'))

const backupPath = (filePath) => filePath.replace(/\.json$/i, '.bak')

const nuuk = () => ({
  place: { kind: 'city', nameZh: '努克', nameEn: 'Nuuk', countryCode: 'gl', lat: 64.18, lng: -51.72 },
  note: '格陵兰首府',
})

// ---------------------------------------------------------------------------
// read()
// ---------------------------------------------------------------------------

test('文件不存在时 read() 创建默认文件并返回它', () => withStore(async ({ store, filePath }) => {
  assert.equal(existsSync(filePath), false)
  const file = await store.read()
  assert.deepEqual(file, {
    schema_version: 1,
    generated_at: FIXED_NOW.toISOString(),
    privacy_level: 'local-only',
    items: [],
  })
  assert.deepEqual(await readRaw(filePath), file)
  // 第一次创建时没有旧文件可备份。
  assert.equal(existsSync(backupPath(filePath)), false)
}))

test('items 不是数组时按空列表处理', () => withStore(async ({ store, filePath }) => {
  await writeFile(filePath, JSON.stringify({ schema_version: 1, items: { a: 1 } }), 'utf8')
  assert.deepEqual((await store.read()).items, [])
}))

test('schema_version 不为 1 时 read() 抛错', () => withStore(async ({ store, filePath }) => {
  await writeFile(filePath, JSON.stringify({ schema_version: 2, items: [] }), 'utf8')
  await assert.rejects(store.read(), /schema_version 不受支持/)
}))

// ---------------------------------------------------------------------------
// add()
// ---------------------------------------------------------------------------

test('add 正常路径：写入条目、生成 id、更新 generated_at', () => withStore(async ({ store, filePath }) => {
  const { id, item } = await store.add(nuuk())
  assert.equal(id, `wtg_${FIXED_DATE}_nuuk`)
  assert.deepEqual(item, {
    id: `wtg_${FIXED_DATE}_nuuk`,
    place: { kind: 'city', nameZh: '努克', nameEn: 'Nuuk', countryCode: 'GL', lat: 64.18, lng: -51.72 },
    note: '格陵兰首府',
    addedAt: FIXED_DATE,
    hidden: false,
    source: 'local-editor',
  })

  const file = await readRaw(filePath)
  assert.equal(file.schema_version, 1)
  assert.equal(file.privacy_level, 'local-only')
  assert.equal(file.generated_at, FIXED_NOW.toISOString())
  assert.deepEqual(file.items, [item])
}))

test('add 允许没有坐标的地点（D06），nameZh 缺省回落为 nameEn', () => withStore(async ({ store }) => {
  const { item } = await store.add({ place: { kind: 'country', nameEn: 'Greenland', countryCode: 'GL' } })
  assert.deepEqual(item.place, {
    kind: 'country',
    nameZh: 'Greenland',
    nameEn: 'Greenland',
    countryCode: 'GL',
  })
  assert.equal('lat' in item.place, false)
  assert.equal('note' in item, false)
}))

test('add 接受显式 addedAt 并用它组成 id', () => withStore(async ({ store }) => {
  const { id, item } = await store.add({
    place: { kind: 'city', nameEn: 'Ilulissat', countryCode: 'GL' },
    addedAt: '2025-01-02',
  })
  assert.equal(id, 'wtg_2025-01-02_ilulissat')
  assert.equal(item.addedAt, '2025-01-02')
}))

test('add 拒绝非法的 kind', () => withStore(async ({ store }) => {
  await assert.rejects(
    store.add({ place: { kind: 'poi', nameEn: 'Nuuk', countryCode: 'GL' } }),
    /想去条目的类型只能是 city 或 country。/,
  )
}))

test('add 缺 nameEn 时报错', () => withStore(async ({ store }) => {
  await assert.rejects(
    store.add({ place: { kind: 'city', nameZh: '努克', countryCode: 'GL' } }),
    /请填写地点英文名。/,
  )
}))

test('add 拒绝坏的 countryCode', () => withStore(async ({ store }) => {
  await assert.rejects(
    store.add({ place: { kind: 'city', nameEn: 'Nuuk', countryCode: 'GRL' } }),
    /国家代码必须是两个英文字母。/,
  )
  await assert.rejects(
    store.add({ place: { kind: 'city', nameEn: 'Nuuk', countryCode: '' } }),
    /请填写国家代码。/,
  )
}))

test('add 拒绝只给 lat 不给 lng', () => withStore(async ({ store }) => {
  await assert.rejects(
    store.add({ place: { kind: 'city', nameEn: 'Nuuk', countryCode: 'GL', lat: 64.18 } }),
    /经纬度需要同时填写，或同时留空。/,
  )
}))

test('add 拒绝超出范围或非有限的坐标', () => withStore(async ({ store }) => {
  await assert.rejects(
    store.add({ place: { kind: 'city', nameEn: 'Nuuk', countryCode: 'GL', lat: 95, lng: 0 } }),
    /纬度无效。/,
  )
  await assert.rejects(
    store.add({ place: { kind: 'city', nameEn: 'Nuuk', countryCode: 'GL', lat: 0, lng: 'abc' } }),
    /经度无效。/,
  )
}))

test('add 拒绝超过 200 字的备注', () => withStore(async ({ store }) => {
  await assert.rejects(
    store.add({ place: { kind: 'city', nameEn: 'Nuuk', countryCode: 'GL' }, note: '好'.repeat(201) }),
    /备注最多 200 字。/,
  )
}))

test('add 拒绝格式错误的 addedAt', () => withStore(async ({ store }) => {
  await assert.rejects(
    store.add({ place: { kind: 'city', nameEn: 'Nuuk', countryCode: 'GL' }, addedAt: '2026/09/17' }),
    /加入日期必须使用 YYYY-MM-DD。/,
  )
}))

test('重复地点按 countryCode + slug(nameEn) 拒绝，隐藏的条目也算（FR-WTG-8）', () => withStore(async ({ store }) => {
  const { id } = await store.add(nuuk())
  await assert.rejects(store.add(nuuk()), /这个地方已在想去列表中。/)
  // 大小写与标点差异不算新地点。
  await assert.rejects(
    store.add({ place: { kind: 'city', nameEn: ' nuuk ', countryCode: 'gl' } }),
    /这个地方已在想去列表中。/,
  )
  await store.update({ id, hidden: true })
  await assert.rejects(store.add(nuuk()), /这个地方已在想去列表中。/)
}))

test('id 冲突时追加 -2 / -3 后缀', () => withStore(async ({ store }) => {
  // 同名不同国：去重键不同，但 id 基底相同。
  const first = await store.add({ place: { kind: 'city', nameEn: 'Nuuk', countryCode: 'GL' } })
  const second = await store.add({ place: { kind: 'city', nameEn: 'Nuuk', countryCode: 'DK' } })
  const third = await store.add({ place: { kind: 'city', nameEn: 'Nuuk', countryCode: 'IS' } })
  assert.equal(first.id, `wtg_${FIXED_DATE}_nuuk`)
  assert.equal(second.id, `wtg_${FIXED_DATE}_nuuk-2`)
  assert.equal(third.id, `wtg_${FIXED_DATE}_nuuk-3`)
}))

// ---------------------------------------------------------------------------
// update()
// ---------------------------------------------------------------------------

test('update 可以隐藏与恢复', () => withStore(async ({ store, filePath }) => {
  const { id } = await store.add(nuuk())
  assert.equal((await store.update({ id, hidden: true })).item.hidden, true)
  assert.equal((await readRaw(filePath)).items[0].hidden, true)
  assert.equal((await store.update({ id, hidden: false })).item.hidden, false)
  assert.equal((await readRaw(filePath)).items[0].hidden, false)
}))

test('update 可以改备注，传空串表示删除备注', () => withStore(async ({ store, filePath }) => {
  const { id } = await store.add(nuuk())
  assert.equal((await store.update({ id, note: '  下一站  ' })).item.note, '下一站')
  const cleared = await store.update({ id, note: '' })
  assert.equal('note' in cleared.item, false)
  assert.equal('note' in (await readRaw(filePath)).items[0], false)
}))

test('update 拒绝超长备注与非布尔的 hidden', () => withStore(async ({ store }) => {
  const { id } = await store.add(nuuk())
  await assert.rejects(store.update({ id, note: '好'.repeat(201) }), /备注最多 200 字。/)
  await assert.rejects(store.update({ id, hidden: 'true' }), /隐藏状态只能是 true 或 false。/)
}))

test('update 至少要改一项', () => withStore(async ({ store }) => {
  const { id } = await store.add(nuuk())
  await assert.rejects(store.update({ id }), /没有需要更新的想去记录内容。/)
}))

test('update 未知 id 时报错', () => withStore(async ({ store }) => {
  await store.add(nuuk())
  await assert.rejects(store.update({ id: 'wtg_missing', hidden: true }), /找不到这条想去记录。/)
}))

// ---------------------------------------------------------------------------
// deleteHidden()
// ---------------------------------------------------------------------------

test('deleteHidden 拒绝未隐藏的记录，并整批不删（FR-WTG-5）', () => withStore(async ({ store, filePath }) => {
  const first = await store.add(nuuk())
  const second = await store.add({ place: { kind: 'city', nameEn: 'Ilulissat', countryCode: 'GL' } })
  await store.update({ id: second.id, hidden: true })

  await assert.rejects(
    store.deleteHidden({ ids: [first.id, second.id] }),
    new RegExp(`只能彻底删除已隐藏的想去记录。以下记录不符合条件：${first.id}`),
  )
  assert.equal((await readRaw(filePath)).items.length, 2)
}))

test('deleteHidden 拒绝未知 id', () => withStore(async ({ store }) => {
  const { id } = await store.add(nuuk())
  await store.update({ id, hidden: true })
  await assert.rejects(
    store.deleteHidden({ ids: [id, 'wtg_missing'] }),
    /只能彻底删除已隐藏的想去记录。以下记录不符合条件：wtg_missing/,
  )
}))

test('deleteHidden 拒绝空的或非字符串的 ids', () => withStore(async ({ store }) => {
  await assert.rejects(store.deleteHidden({ ids: [] }), /没有可删除的隐藏想去记录。/)
  await assert.rejects(store.deleteHidden({ ids: 'wtg_x' }), /没有可删除的隐藏想去记录。/)
  await assert.rejects(store.deleteHidden({ ids: [1, 2] }), /没有可删除的隐藏想去记录。/)
}))

test('deleteHidden 成功删除已隐藏的记录', () => withStore(async ({ store, filePath }) => {
  const first = await store.add(nuuk())
  const second = await store.add({ place: { kind: 'city', nameEn: 'Ilulissat', countryCode: 'GL' } })
  await store.update({ id: first.id, hidden: true })

  const { deletedIds } = await store.deleteHidden({ ids: [first.id] })
  assert.deepEqual(deletedIds, [first.id])
  const file = await readRaw(filePath)
  assert.deepEqual(file.items.map((item) => item.id), [second.id])
}))

// ---------------------------------------------------------------------------
// remove()（PR9：转为足迹后移除）
// ---------------------------------------------------------------------------

test('remove 删除一条未隐藏的记录，其余记录不动', () => withStore(async ({ store, filePath }) => {
  const first = await store.add(nuuk())
  const second = await store.add({ place: { kind: 'city', nameEn: 'Ilulissat', countryCode: 'GL' } })

  assert.deepEqual(await store.remove({ id: first.id }), { removedId: first.id })
  const file = await readRaw(filePath)
  assert.deepEqual(file.items.map((item) => item.id), [second.id])
  assert.equal(file.generated_at, FIXED_NOW.toISOString())
  // 原子写：上一版留在 .bak 里。
  assert.equal(JSON.parse(await readFile(backupPath(filePath), 'utf8')).items.length, 2)
}))

test('remove 同样可以删除已隐藏的记录', () => withStore(async ({ store, filePath }) => {
  const { id } = await store.add(nuuk())
  await store.update({ id, hidden: true })
  await store.remove({ id })
  assert.deepEqual((await readRaw(filePath)).items, [])
}))

test('remove 未知 id 时报错且不写文件', () => withStore(async ({ store, filePath }) => {
  await store.add(nuuk())
  const before = await readFile(filePath, 'utf8')
  await assert.rejects(store.remove({ id: 'wtg_missing' }), /找不到这条想去记录。/)
  await assert.rejects(store.remove({}), /请填写想去记录 id。/)
  assert.equal(await readFile(filePath, 'utf8'), before)
}))

// ---------------------------------------------------------------------------
// 原子写行为
// ---------------------------------------------------------------------------

test('每次写入后都留下 .bak 备份，且目录里没有残留的 .tmp', () => withStore(async ({ store, filePath, directory }) => {
  const { id } = await store.add(nuuk())
  assert.equal(existsSync(backupPath(filePath)), true)

  await store.update({ id, hidden: true })
  // .bak 是上一版：此时它里面的条目还没有被隐藏。
  const backup = JSON.parse(await readFile(backupPath(filePath), 'utf8'))
  assert.equal(backup.items[0].hidden, false)

  await store.deleteHidden({ ids: [id] })
  assert.equal(JSON.parse(await readFile(backupPath(filePath), 'utf8')).items.length, 1)
  assert.deepEqual((await readRaw(filePath)).items, [])

  const { readdir } = await import('node:fs/promises')
  const leftovers = (await readdir(directory)).filter((name) => name.endsWith('.tmp'))
  assert.deepEqual(leftovers, [])
}))
