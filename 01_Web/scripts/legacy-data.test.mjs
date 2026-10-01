/**
 * scripts/legacy-data.mjs 的测试（RFC-LOC-1 PR5a 规格决定 I、§4.2、§5）：「未迁移」的判定与写入拒绝。
 *
 * 四种情况：未迁移（只有旧文件）、残留（旧文件 + V2 文件）、全新（都没有）、只有 `.bak`（不算任何一种文件）；
 * 外加只有 V2 文件、PR4 的数据模式标记被忽略、写入拒绝的纯函数（409 与 E_LEGACY_UNMIGRATED）。
 *
 * 运行方式：npm test。私人根一律是 fs.mkdtemp 建的临时目录，绝不读作者的真实私有层；用例结束时删除。
 * 这里只建空文件或随便写点内容：判定只看文件在不在，不读内容。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  hasLegacyData,
  hasV2Data,
  isLegacyUnmigrated,
  LEGACY_MIGRATION_STEPS,
  LEGACY_UNMIGRATED_CODE,
  LEGACY_UNMIGRATED_IMPORT_MESSAGE,
  LEGACY_UNMIGRATED_STATUS,
  LEGACY_UNMIGRATED_WRITE_MESSAGE,
  legacyDataPaths,
  legacyDataStateOf,
  legacyWriteRefusal,
} from './legacy-data.mjs'
import { getPrivatePaths } from './private-profile.mjs'
import { LEGACY_UNMIGRATED_NOTICE } from '../src/data/privateDataNotice.ts'

const LEGACY_FILE_NAMES = ['travel-map.local.json', 'want-to-go.local.json', 'editor-state.local.json', 'user-media.local.json']

const withPrivateRoot = async (run) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'starmap-legacy-data-test-'))
  try {
    const paths = getPrivatePaths({ STARMAP_PRIVATE_ROOT: directory })
    await mkdir(paths.v2DataRoot, { recursive: true })
    await run(paths)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

const touch = (target, content = '{}') => writeFile(target, content, 'utf8')

/** `<目录>/<名字>.json` → `<目录>/<名字>.bak`，与 atomicJsonWrite 的命名相同。 */
const bakOf = (filePath) => filePath.replace(/\.json$/i, '.bak')

test('legacyDataPaths：四个旧数据文件，就在 data/ 下，顺序与迁移工具的旧文件哈希一致', () => {
  const paths = getPrivatePaths({ STARMAP_PRIVATE_ROOT: path.join(tmpdir(), 'starmap-legacy-data-paths') })
  assert.deepEqual(legacyDataPaths(paths), LEGACY_FILE_NAMES.map((name) => path.join(paths.dataRoot, name)))
  assert.equal(Object.hasOwn(paths, 'dataModePath'), false, 'PR5a 删除了数据模式标记的路径')
})

test('未迁移：只有旧文件（任一个即可），data/v2/ 里没有 V2 文件', () => withPrivateRoot(async (paths) => {
  for (const [index, filePath] of legacyDataPaths(paths).entries()) {
    await touch(filePath)
    const state = legacyDataStateOf(paths)
    assert.deepEqual(state, { legacyFiles: LEGACY_FILE_NAMES.slice(0, index + 1), v2Files: [] })
    assert.equal(isLegacyUnmigrated(state), true)
    assert.equal(hasLegacyData(paths), true)
    assert.equal(hasV2Data(paths), false)
  }
}))

test('残留：旧文件与 V2 文件都在（已经迁移过）→ 不算未迁移；任何一个 V2 文件就够', () => withPrivateRoot(async (paths) => {
  await touch(paths.localTravelMapPath)
  await touch(paths.wantToGoPath)
  for (const key of ['places', 'travel', 'wantToGo', 'editorState', 'media']) {
    await rm(paths.v2DataRoot, { recursive: true, force: true })
    await mkdir(paths.v2DataRoot, { recursive: true })
    await touch(paths.v2FilePaths[key])
    const state = legacyDataStateOf(paths)
    assert.deepEqual(state.legacyFiles, ['travel-map.local.json', 'want-to-go.local.json'])
    assert.deepEqual(state.v2Files, [path.basename(paths.v2FilePaths[key])])
    assert.equal(isLegacyUnmigrated(state), false, key)
  }
}))

test('全新目录（什么都没有，data/ 都可以不存在）与只有 V2 文件 → 不算未迁移', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'starmap-legacy-data-test-'))
  try {
    const paths = getPrivatePaths({ STARMAP_PRIVATE_ROOT: path.join(directory, 'missing') })
    assert.deepEqual(legacyDataStateOf(paths), { legacyFiles: [], v2Files: [] })
    assert.equal(isLegacyUnmigrated(legacyDataStateOf(paths)), false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
  await withPrivateRoot(async (paths) => {
    assert.equal(isLegacyUnmigrated(legacyDataStateOf(paths)), false)
    for (const filePath of Object.values(paths.v2FilePaths)) await touch(filePath)
    const state = legacyDataStateOf(paths)
    assert.deepEqual(state.legacyFiles, [])
    assert.equal(state.v2Files.length, 5)
    assert.equal(isLegacyUnmigrated(state), false)
  })
})

test('只有 .bak：旧文件的 .bak 不算旧数据，V2 文件的 .bak 不算 V2 文件；判定只看确切的文件名', () => withPrivateRoot(async (paths) => {
  for (const filePath of [...legacyDataPaths(paths), ...Object.values(paths.v2FilePaths)]) await touch(bakOf(filePath))
  assert.deepEqual(legacyDataStateOf(paths), { legacyFiles: [], v2Files: [] })
  assert.equal(hasLegacyData(paths), false)
  assert.equal(hasV2Data(paths), false)
  assert.equal(isLegacyUnmigrated(legacyDataStateOf(paths)), false, '只有 .bak 等于全新目录')

  // 有旧文件、data/v2/ 里只有 .bak → 仍是未迁移（.bak 不能冒充迁移过）。
  await touch(paths.editorStatePath)
  assert.equal(isLegacyUnmigrated(legacyDataStateOf(paths)), true)
}))

test('PR4 的数据模式标记被忽略：{ "mode": "legacy" } 不让残留变回旧模式，{ "mode": "v2" } 不让未迁移变成已迁移，损坏的标记也不报错', () => withPrivateRoot(async (paths) => {
  const marker = path.join(paths.dataRoot, 'data-mode.local.json')
  await touch(paths.localTravelMapPath)
  for (const content of ['{ "mode": "v2" }', '{ "mode": "legacy" }', '{ this is not json']) {
    await touch(marker, content)
    assert.equal(isLegacyUnmigrated(legacyDataStateOf(paths)), true, content)
  }
  await touch(paths.v2FilePaths.places)
  for (const content of ['{ "mode": "v2" }', '{ "mode": "legacy" }', '{ this is not json']) {
    await touch(marker, content)
    assert.equal(isLegacyUnmigrated(legacyDataStateOf(paths)), false, content)
  }
}))

test('isLegacyUnmigrated 是纯函数：有旧文件且没有 V2 文件', () => {
  assert.equal(isLegacyUnmigrated({ legacyFiles: ['travel-map.local.json'], v2Files: [] }), true)
  assert.equal(isLegacyUnmigrated({ legacyFiles: ['travel-map.local.json'], v2Files: ['places.local.json'] }), false)
  assert.equal(isLegacyUnmigrated({ legacyFiles: [], v2Files: [] }), false)
  assert.equal(isLegacyUnmigrated({ legacyFiles: [], v2Files: ['places.local.json'] }), false)
})

test('写入拒绝（纯函数）：未迁移时 409 与 E_LEGACY_UNMIGRATED，形状同 V2 写入的错误 { ok, error, code, params }；其他情况不拒绝', () => {
  const state = { legacyFiles: ['travel-map.local.json', 'user-media.local.json'], v2Files: [] }
  const refusal = legacyWriteRefusal(state)
  assert.equal(LEGACY_UNMIGRATED_STATUS, 409)
  assert.equal(LEGACY_UNMIGRATED_CODE, 'E_LEGACY_UNMIGRATED')
  assert.deepEqual(refusal, {
    status: 409,
    body: {
      ok: false,
      error: LEGACY_UNMIGRATED_WRITE_MESSAGE,
      code: 'E_LEGACY_UNMIGRATED',
      params: { legacyFiles: ['travel-map.local.json', 'user-media.local.json'] },
    },
  })
  assert.notEqual(refusal.body.params.legacyFiles, state.legacyFiles, '参数是副本')
  for (const other of [
    { legacyFiles: ['travel-map.local.json'], v2Files: ['places.local.json'] },
    { legacyFiles: [], v2Files: [] },
    { legacyFiles: [], v2Files: ['places.local.json'] },
  ]) {
    assert.equal(legacyWriteRefusal(other), undefined, JSON.stringify(other))
  }
})

test('文案：中文说明怎么迁移（检出提交 4fd32a9，步骤见 README）与怎么放弃旧数据；编辑器与导入器共用同一段步骤；与页面的迁移提示用同样的提交号、README 小节和文件名', () => {
  assert.match(LEGACY_UNMIGRATED_WRITE_MESSAGE, /^私人目录里有旧格式的数据，还没有迁移，这次修改没有保存。/)
  assert.match(LEGACY_UNMIGRATED_IMPORT_MESSAGE, /^私人目录里有旧格式的数据，还没有迁移，没有导入任何媒体。/)
  for (const message of [LEGACY_UNMIGRATED_WRITE_MESSAGE, LEGACY_UNMIGRATED_IMPORT_MESSAGE]) {
    assert.ok(message.endsWith(LEGACY_MIGRATION_STEPS))
  }
  const notice = LEGACY_UNMIGRATED_NOTICE.join('\n')
  for (const fragment of [
    '这个版本不再带迁移工具，请先检出 StarMap 的提交 4fd32a9（最后一个带迁移工具的版本）完成迁移，再回到最新版本',
    '步骤见 README 的 Private Data Format 一节',
    '把私人目录 data/ 下的四个旧文件（travel-map、want-to-go、editor-state、user-media 的 .local.json）移到别处',
  ]) {
    assert.ok(LEGACY_MIGRATION_STEPS.includes(fragment), fragment)
    assert.ok(notice.includes(fragment), fragment)
  }
  // PR5b：迁移工具已删除，不能再让人运行 identity:check。
  for (const text of [LEGACY_MIGRATION_STEPS, notice]) assert.doesNotMatch(text, /identity:check|数据模式|data-mode|--switch/)
})
