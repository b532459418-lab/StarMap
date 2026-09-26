/**
 * V2 Reader（canonical/v2Reader.ts）的单元测试（RFC-LOC-1 PR3a 规格 §2.2、§4）。
 *
 * 运行方式：npm test。零依赖：Node 24 自带类型剥离，只用 node:test + node:assert/strict。
 * 与 Serializer 互逆的主测试在 ./v2Serializer.test.ts；这里测 Reader 自己的规则。
 */

/// <reference types="node" />

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { consistentPersonalRaw, sampleRaw } from './legacy.fixture.ts'
import { legacyAdapter } from './legacyAdapter.ts'
import { toV2Space } from './v2.fixture.ts'
import { readV2 } from './v2Reader.ts'
import type { V2Files } from './v2Schema.ts'
import { serializeV2 } from './v2Serializer.ts'

const sampleFiles = (raw = sampleRaw()): V2Files => {
  const { data } = toV2Space(legacyAdapter(raw))
  return JSON.parse(JSON.stringify(serializeV2(data, {
    placesGeneratedAt: '2026-09-26T00:00:00.000Z',
    wantToGo: { generated_at: '2026-08-12T00:00:00.000Z' },
    media: { generatedAt: '2030-01-02T03:04:05.000Z' },
  }))) as V2Files
}

test('运行时字段：source 固定为 local，problems 为空', () => {
  const read = readV2(sampleFiles())
  assert.equal(read.travel.source, 'local')
  assert.equal(read.wantToGo.source, 'local')
  assert.deepEqual(read.wantToGo.problems, [])
  assert.deepEqual(read.media.problems, [])
})

test('足迹元数据：蛇形字段名换回 Canonical 的驼峰；没有的字段不出现', () => {
  const files = sampleFiles()
  assert.deepEqual(readV2(files).travel.meta, {
    schemaVersion: 2,
    generatedAt: '2026-08-12',
    privacyLevel: 'public-sample',
    intendedUse: 'Neutral open-source StarMap demonstration data.',
    safetyNotes: files.travel.safety_notes,
  })
  delete files.travel.generated_at
  delete files.travel.safety_notes
  const meta = readV2(files).travel.meta
  assert.deepEqual(Object.keys(meta), ['schemaVersion', 'privacyLevel', 'intendedUse'])
})

test('省略坐标的记录用城市坐标填回；城市没有坐标时保持省略；只省略一个键的记录原样读', () => {
  const files = sampleFiles()
  const [first, second] = files.travel.records
  assert.equal(Object.hasOwn(first, 'lat'), false)
  const city = files.places.places.find((place) => place.id === first.placeId)!
  assert.deepEqual(readV2(files).travel.records[0].lat, city.location!.lat)

  delete city.location
  const withoutCityLocation = readV2(files).travel.records[0]
  assert.equal(Object.hasOwn(withoutCityLocation, 'lat') || Object.hasOwn(withoutCityLocation, 'lng'), false)

  const secondCity = files.places.places.find((place) => place.id === second.placeId)!
  second.lat = secondCity.location!.lat
  const half = readV2(files).travel.records[1]
  assert.equal(half.lat, secondCity.location!.lat)
  assert.equal(Object.hasOwn(half, 'lng'), false)
})

test('Canonical 里没有的文件级元数据读时丢弃；输出不与输入共享引用', () => {
  const files = sampleFiles(consistentPersonalRaw())
  const read = readV2(files)
  assert.equal(JSON.stringify(read).includes('2026-09-26T00:00:00.000Z'), false)
  assert.equal(JSON.stringify(read).includes('2030-01-02T03:04:05.000Z'), false)

  const before = JSON.stringify(files)
  read.places[0].names.en = 'Changed'
  read.editorState.countryOrder.push('x')
  read.media.items.pop()
  assert.equal(JSON.stringify(files), before)
})
