/**
 * V2 Serializer（canonical/v2Serializer.ts）的单元测试（RFC-LOC-1 PR3a 规格 §2.2、§4）。
 *
 * 运行方式：npm test。零依赖：Node 24 自带类型剥离，只用 node:test + node:assert/strict。
 *
 * 两种 V2 数据：`toV2Space`（./v2.fixture.ts）直接从 Legacy Adapter 的输出搬进 V2 id 空间、不做地点合并；
 * 以及迁移规划（../migration/planMigration.ts）在合并与决定之后产出的 M。
 */

/// <reference types="node" />

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { consistentPersonalRaw, nameInconsistencyRaw, rawInputs, record, sampleRaw } from './legacy.fixture.ts'
import { legacyAdapter } from './legacyAdapter.ts'
import type { CanonicalData } from './types.ts'
import { fileMetaFromRaw, planMigration } from '../migration/planMigration.ts'
import { sequentialUuids, toV2Space } from './v2.fixture.ts'
import { readV2 } from './v2Reader.ts'
import { validateV2Files, type V2Files } from './v2Schema.ts'
import { serializeV2, type V2FileMeta } from './v2Serializer.ts'

const META: V2FileMeta = { placesGeneratedAt: '2026-09-26T00:00:00.000Z' }

/** 经磁盘往返：写成 JSON 文本再解析，与 CLI 实际写盘、读盘一致。 */
const throughDisk = (files: V2Files): V2Files => JSON.parse(JSON.stringify(files)) as V2Files

const roundTrip = (data: CanonicalData, meta: V2FileMeta = META) => {
  const files = serializeV2(data, meta)
  assert.deepEqual(validateV2Files(files), [])
  return { files, read: readV2(throughDisk(files)) }
}

test('三份 PR2 fixture：写成 V2 文件后通过校验，读回与原 Canonical 深度相等', () => {
  for (const [name, raw] of [
    ['公开样例', sampleRaw()],
    ['consistentPersonalRaw', consistentPersonalRaw()],
    ['nameInconsistencyRaw', nameInconsistencyRaw()],
  ] as const) {
    const { data } = toV2Space(legacyAdapter(raw))
    const { read } = roundTrip(data)
    assert.deepStrictEqual(read, data, name)
  }
})

test('三份 PR2 fixture 经迁移规划（合并之后的 L′ → M）：写出再读回与 M 深度相等', () => {
  for (const [name, raw] of [
    ['公开样例', sampleRaw()],
    ['consistentPersonalRaw', consistentPersonalRaw()],
    ['nameInconsistencyRaw', nameInconsistencyRaw()],
  ] as const) {
    const migrated = planMigration({
      raw,
      fileMeta: fileMetaFromRaw(raw),
      sourceHash: 'x',
      newId: sequentialUuids(),
      now: '2026-09-26T00:00:00.000Z',
    }).canonical.migrated!
    const { read } = roundTrip(migrated, { placesGeneratedAt: 'x', ...fileMetaFromRaw(raw) })
    assert.deepStrictEqual(read, migrated, name)
  }
})

test('写出的形状：足迹元数据改回蛇形字段名；运行时字段不写；地点注册表带 generated_at', () => {
  const { data } = toV2Space(legacyAdapter(sampleRaw()))
  const files = serializeV2(data, META)
  assert.deepEqual(Object.keys(files.travel), ['schema_version', 'generated_at', 'privacy_level', 'intended_use', 'safety_notes', 'display', 'records'])
  assert.equal(files.travel.schema_version, 2)
  assert.equal(files.travel.generated_at, '2026-08-12')
  assert.deepEqual(files.places, { schema_version: 1, generated_at: '2026-09-26T00:00:00.000Z', places: data.places })
  assert.equal(files.editorState.schemaVersion, 2)
  assert.equal(files.media.schemaVersion, 3)
  // 运行时字段不写（想去条目自己的 `source` 是数据，照写）。
  for (const file of [files.travel, files.wantToGo, files.media]) {
    assert.equal(Object.hasOwn(file, 'source') || Object.hasOwn(file, 'problems'), false)
  }
  assert.equal(files.wantToGo.items[0].source, 'sample')
})

test('记录坐标：与城市相同 → 省略两个键；null → 写 null；自身坐标 → 原样写；读回都还原', () => {
  const raw = rawInputs({
    records: [
      record({ id: 'same', start_date: '2025-06-01' }),
      record({ id: 'own', start_date: '2025-06-02', lat: 64.2, lng: -21.8 }),
      record({ id: 'none', start_date: '2025-06-03', lat: null, lng: null }),
      record({ id: 'half', start_date: '2025-06-04', lat: 64.1466, lng: null }),
    ],
  })
  const { data } = toV2Space(legacyAdapter(raw))
  const city = data.places.find((place) => place.subtype === 'city')!
  assert.deepEqual(city.location, { lat: 64.1466, lng: -21.9426 })

  const { files, read } = roundTrip(data)
  const [same, own, none, half] = files.travel.records
  assert.equal(Object.hasOwn(same, 'lat') || Object.hasOwn(same, 'lng'), false)
  assert.deepEqual([own.lat, own.lng], [64.2, -21.8])
  assert.deepEqual([none.lat, none.lng], [null, null])
  assert.ok(Object.hasOwn(none, 'lat') && Object.hasOwn(none, 'lng'))
  assert.deepEqual([half.lat, half.lng], [64.1466, null])

  assert.deepStrictEqual(read, data)
  assert.deepEqual(read.travel.records.map((item) => [item.id, item.lat, item.lng]), [
    ['same', 64.1466, -21.9426],
    ['own', 64.2, -21.8],
    ['none', null, null],
    ['half', 64.1466, null],
  ])
})

test('文件级元数据原样保留：想去只搬三个字段，媒体搬 schemaVersion 与 items 以外的全部顶层字段', () => {
  const { data } = toV2Space(legacyAdapter(consistentPersonalRaw()))
  const files = serializeV2(data, {
    placesGeneratedAt: 'x',
    wantToGo: { schema_version: 1, generated_at: '2026-08-12T00:00:00.000Z', privacy_level: 'local-only', intended_use: 'Personal.', items: ['ignored'], extra: 1 },
    media: { schemaVersion: 2, generatedAt: '2026-09-01T00:00:00.000Z', privacyLevel: 'local-only', items: ['ignored'], note: { nested: true } },
  })
  assert.deepEqual(Object.keys(files.wantToGo), ['schema_version', 'generated_at', 'privacy_level', 'intended_use', 'items'])
  assert.equal(files.wantToGo.schema_version, 2)
  assert.equal(files.wantToGo.privacy_level, 'local-only')
  assert.deepEqual(Object.keys(files.media), ['schemaVersion', 'generatedAt', 'privacyLevel', 'note', 'items'])
  assert.equal(files.media.schemaVersion, 3)
  assert.deepEqual(files.media.note, { nested: true })
  assert.equal(files.media.items.length, 3)
  assert.deepEqual(validateV2Files(files), [])

  // 没有旧文件时不写这些字段。
  const bare = serializeV2(data, { placesGeneratedAt: 'x' })
  assert.deepEqual(Object.keys(bare.wantToGo), ['schema_version', 'items'])
  assert.deepEqual(Object.keys(bare.media), ['schemaVersion', 'items'])
})

test('输出不与输入共享引用，也不改输入', () => {
  const { data } = toV2Space(legacyAdapter(consistentPersonalRaw()))
  const before = JSON.stringify(data)
  const files = serializeV2(data, META)
  files.places.places[0].names.en = 'Changed'
  files.travel.records.pop()
  files.editorState.hiddenCityIds.push('x')
  assert.equal(JSON.stringify(data), before)
})
