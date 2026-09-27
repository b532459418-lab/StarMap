/**
 * canonicalForInputs（按数据模式取 Canonical）的单元测试（RFC-LOC-1 PR3b-1 规格 §2.2、§3）。
 *
 * 运行方式：npm test。零依赖：Node 24 自带类型剥离，只用 node:test + node:assert/strict。
 *
 * 下面这行 reference 不能删，理由见 src/worldgraph/adapters/travel.test.ts 文件头。
 */

/// <reference types="node" />

import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { RawAppInputs } from '../derive/appData.ts'
import { planMigration, fileMetaFromRaw } from '../migration/planMigration.ts'
import {
  canonicalForInputs,
  completeV2Files,
  emptyV2Files,
  V2FilesInvalidError,
  type V2FileInputs,
} from './canonicalForInputs.ts'
import { deriveAppDataFromCanonical } from './derive.ts'
import { NOW, baselineText, consistentPersonalRaw, sampleRaw } from './legacy.fixture.ts'
import { legacyAdapter } from './legacyAdapter.ts'
import { sequentialUuids } from './v2.fixture.ts'
import { readV2 } from './v2Reader.ts'
import { V2_FILE_KEYS, validateV2Files, type V2Files } from './v2Schema.ts'

/** PR3a 的迁移：consistentPersonalRaw → V2 文件（M 与 write(M)）。 */
const migrated = () => {
  const raw = { ...consistentPersonalRaw(), now: NOW }
  const result = planMigration({
    raw,
    fileMeta: fileMetaFromRaw(raw),
    sourceHash: 'test',
    newId: sequentialUuids(),
    now: NOW,
  })
  assert.equal(result.report.canApply, true)
  return { files: JSON.parse(JSON.stringify(result.files!)) as V2Files, M: result.canonical.migrated! }
}

/** 旧格式输入的每个字段都换成读了就抛错的 getter：证明 V2 模式根本不读它们。 */
const trapLegacyFields = <T extends object>(inputs: T): T => {
  for (const key of ['travelMap', 'travelAtlasDataSource', 'editorState', 'mediaCatalog', 'wantToGo', 'now']) {
    Object.defineProperty(inputs, key, {
      enumerable: true,
      get() {
        throw new Error(`V2 模式读了旧格式输入 ${key}`)
      },
    })
  }
  return inputs
}

test('legacy 模式：与 legacyAdapter 完全相同（公开样例与个人数据）', () => {
  for (const raw of [sampleRaw(), consistentPersonalRaw({ withDanglingMedia: true })]) {
    assert.deepStrictEqual(canonicalForInputs({ ...raw, dataMode: 'legacy' }), legacyAdapter(raw))
  }
})

test('v2 模式：完整文件与 PR3a 的 read(write(M)) 相同，也与 M 深度相等', () => {
  const { files, M } = migrated()
  const canonical = canonicalForInputs({ dataMode: 'v2', v2Files: files })
  assert.deepStrictEqual(canonical, readV2(files))
  assert.deepStrictEqual(canonical, M)
  assert.equal(canonical.travel.source, 'local')
  assert.equal(canonical.wantToGo.source, 'local')
})

test('v2 模式不读旧格式输入：旧字段一碰就抛错也照样得到 V2 的结果', () => {
  const { files } = migrated()
  const inputs = trapLegacyFields({ dataMode: 'v2' as const, v2Files: files })
  assert.deepStrictEqual(canonicalForInputs(inputs), readV2(files))
  // 对照：legacy 模式确实会读它们。
  const legacyInputs = trapLegacyFields({ ...sampleRaw(), dataMode: 'legacy' as const })
  assert.throws(() => canonicalForInputs(legacyInputs), /读了旧格式输入/)
})

test('emptyV2Files：五个文件合法，读出来是空的 Canonical；每次返回新对象', () => {
  const empty = emptyV2Files()
  assert.deepEqual(Object.keys(empty), V2_FILE_KEYS)
  assert.deepEqual(validateV2Files(empty), [])
  assert.notEqual(emptyV2Files(), empty)
  assert.notEqual(emptyV2Files().places.places, empty.places.places)
})

test('v2 模式 · 五个文件都缺（全新私人目录只有标记）：空的 Canonical，不回落到样例；派生不报错', () => {
  for (const v2Files of [undefined, {}, { places: undefined, travel: undefined, wantToGo: undefined, editorState: undefined, media: undefined }]) {
    const canonical = canonicalForInputs({ dataMode: 'v2', v2Files })
    assert.deepEqual(canonical.places, [])
    assert.deepEqual(canonical.travel.records, [])
    assert.deepEqual(canonical.wantToGo.items, [])
    assert.deepEqual(canonical.media.items, [])
    assert.deepEqual(canonical.editorState, emptyV2Files().editorState)
    assert.deepStrictEqual(canonical, readV2(emptyV2Files()))

    const derived = deriveAppDataFromCanonical(canonical, { now: NOW })
    assert.deepEqual(derived.travelAtlas.countries, [])
    assert.deepEqual(derived.travelAtlas.cities, [])
    assert.deepEqual(derived.travelAtlas.plannedRecords, [])
    assert.deepEqual(derived.wantToGo.wantToGoItems, [])
    assert.deepEqual(derived.mediaCatalog.allImportedMediaItems, [])
    assert.deepEqual(derived.worldGraph.worldGraphSnapshot.entities, [])
    assert.equal(derived.travelAtlas.travelAtlasMeta.importedRecords, 0)
    // 基线也能拍（浏览器场景 4 与 Node 比对用）。
    assert.ok(baselineText(derived).length > 0)
  }
})

test('v2 模式 · 只缺一部分：缺的按空处理，在的原样', () => {
  const { files } = migrated()
  const withoutMedia: V2FileInputs = { ...files, media: undefined }
  const canonical = canonicalForInputs({ dataMode: 'v2', v2Files: withoutMedia })
  assert.deepEqual(canonical.media.items, [])
  assert.deepStrictEqual(canonical.places, readV2(files).places)
  assert.deepStrictEqual(canonical.travel, readV2(files).travel)

  const { editorState: _editorState, wantToGo: _wantToGo, ...rest } = files
  void _editorState
  void _wantToGo
  const partial = canonicalForInputs({ dataMode: 'v2', v2Files: rest })
  assert.deepEqual(partial.editorState, emptyV2Files().editorState)
  assert.deepEqual(partial.wantToGo.items, [])
  assert.equal(partial.travel.records.length, files.travel.records.length)

  // completeV2Files 只补缺的，不改在的。
  const completed = completeV2Files(withoutMedia)
  assert.equal(completed.places, files.places)
  assert.deepEqual(completed.media, emptyV2Files().media)
})

test('v2 模式 · 文件不合法（含「缺了地点注册表、别的文件还引用着地点」）：抛 V2FilesInvalidError，消息不带字段的值', () => {
  const { files } = migrated()
  const withoutPlaces: V2FileInputs = { ...files, places: undefined }
  assert.throws(() => canonicalForInputs({ dataMode: 'v2', v2Files: withoutPlaces }), (error) => {
    assert.ok(error instanceof V2FilesInvalidError)
    assert.match(error.message, /V2 数据文件没有通过校验/)
    assert.match(error.message, /data\/v2\/travel-map\.local\.json \$\.records\[0\]\.placeId：引用的地点不存在/)
    assert.ok(error.problems.length > 0)
    return true
  })

  const namedPlace = files.places.places.find((place) => place.names.en)!
  const broken = JSON.parse(JSON.stringify(files)) as V2Files
  broken.places.places[0] = { ...broken.places.places[0], names: {} }
  broken.travel = null as unknown as V2Files['travel']
  assert.throws(() => canonicalForInputs({ dataMode: 'v2', v2Files: broken }), (error) => {
    assert.ok(error instanceof V2FilesInvalidError)
    assert.ok(!error.message.includes(namedPlace.names.en!), '消息不带地点名称')
    return true
  })
})

test('类型：legacy 输入就是 RawAppInputs 加 dataMode', () => {
  const raw: RawAppInputs = sampleRaw()
  assert.deepStrictEqual(canonicalForInputs({ ...raw, dataMode: 'legacy' }), legacyAdapter(raw))
})
