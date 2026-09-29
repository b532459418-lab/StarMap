/**
 * canonicalForInputs（五个 V2 文件 → Canonical）的单元测试（RFC-LOC-1 PR3b-1 规格 §2.2、§3；PR5a 删除了 legacy 分支与它的用例）。
 *
 * 运行方式：npm test。零依赖：Node 24 自带类型剥离，只用 node:test + node:assert/strict。
 *
 * 下面这行 reference 不能删，理由见 src/worldgraph/adapters/travel.test.ts 文件头。
 */

/// <reference types="node" />

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { planMigration, fileMetaFromRaw } from '../migration/planMigration.ts'
import {
  canonicalForInputs,
  completeV2Files,
  emptyV2Files,
  V2FilesInvalidError,
  type V2FileInputs,
} from './canonicalForInputs.ts'
import { deriveAppDataFromCanonical } from './derive.ts'
import { NOW, baselineText, consistentPersonalRaw } from './legacy.fixture.ts'
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

/** 旧格式输入的每个字段都换成读了就抛错的 getter：证明 canonicalForInputs 根本不读它们。 */
const trapLegacyFields = <T extends object>(inputs: T): T => {
  for (const key of ['travelMap', 'travelAtlasDataSource', 'editorState', 'mediaCatalog', 'wantToGo', 'now', 'dataMode']) {
    Object.defineProperty(inputs, key, {
      enumerable: true,
      get() {
        throw new Error(`读了旧格式输入 ${key}`)
      },
    })
  }
  return inputs
}

test('完整文件：与 PR3a 的 read(write(M)) 相同，也与 M 深度相等', () => {
  const { files, M } = migrated()
  const canonical = canonicalForInputs({ v2Files: files })
  assert.deepStrictEqual(canonical, readV2(files))
  assert.deepStrictEqual(canonical, M)
  assert.equal(canonical.travel.source, 'local')
  assert.equal(canonical.wantToGo.source, 'local')
})

test('不读旧格式输入：旧字段（含 PR5a 删除的 dataMode）一碰就抛错也照样得到 V2 的结果', () => {
  const { files } = migrated()
  const inputs = trapLegacyFields({ v2Files: files })
  assert.deepStrictEqual(canonicalForInputs(inputs), readV2(files))
})

test('emptyV2Files：五个文件合法，读出来是空的 Canonical；每次返回新对象', () => {
  const empty = emptyV2Files()
  assert.deepEqual(Object.keys(empty), V2_FILE_KEYS)
  assert.deepEqual(validateV2Files(empty), [])
  assert.notEqual(emptyV2Files(), empty)
  assert.notEqual(emptyV2Files().places.places, empty.places.places)
})

test('五个文件都缺（全新私人目录）：空的 Canonical，不回落到样例；派生不报错', () => {
  for (const v2Files of [undefined, {}, { places: undefined, travel: undefined, wantToGo: undefined, editorState: undefined, media: undefined }]) {
    const canonical = canonicalForInputs({ v2Files })
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

test('只缺一部分：缺的按空处理，在的原样', () => {
  const { files } = migrated()
  const withoutMedia: V2FileInputs = { ...files, media: undefined }
  const canonical = canonicalForInputs({ v2Files: withoutMedia })
  assert.deepEqual(canonical.media.items, [])
  assert.deepStrictEqual(canonical.places, readV2(files).places)
  assert.deepStrictEqual(canonical.travel, readV2(files).travel)

  const { editorState: _editorState, wantToGo: _wantToGo, ...rest } = files
  void _editorState
  void _wantToGo
  const partial = canonicalForInputs({ v2Files: rest })
  assert.deepEqual(partial.editorState, emptyV2Files().editorState)
  assert.deepEqual(partial.wantToGo.items, [])
  assert.equal(partial.travel.records.length, files.travel.records.length)

  // completeV2Files 只补缺的，不改在的。
  const completed = completeV2Files(withoutMedia)
  assert.equal(completed.places, files.places)
  assert.deepEqual(completed.media, emptyV2Files().media)
})

test('文件不合法（含「缺了地点注册表、别的文件还引用着地点」）：抛 V2FilesInvalidError，消息不带字段的值', () => {
  const { files } = migrated()
  const withoutPlaces: V2FileInputs = { ...files, places: undefined }
  assert.throws(() => canonicalForInputs({ v2Files: withoutPlaces }), (error) => {
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
  assert.throws(() => canonicalForInputs({ v2Files: broken }), (error) => {
    assert.ok(error instanceof V2FilesInvalidError)
    assert.ok(!error.message.includes(namedPlace.names.en!), '消息不带地点名称')
    return true
  })
})
