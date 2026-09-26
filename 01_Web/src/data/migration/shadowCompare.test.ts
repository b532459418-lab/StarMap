/**
 * Shadow compare（migration/shadowCompare.ts）的单元测试（RFC-LOC-1 PR3a 规格 §2.1、§4）。
 *
 * 运行方式：npm test。零依赖：Node 24 自带类型剥离，只用 node:test + node:assert/strict。
 *
 * 做法：对一份能迁移的数据（PR2 的个人模式 fixture：有 editor-state、媒体、想去）拿到 L′ 与真实读回的
 * Canonical，先确认两层都通过；再把读回的结果篡改一处（地点名称、记录的 placeId、媒体的地点），
 * 断言两层都报出差异，且差异落在被改的地方。
 */

/// <reference types="node" />

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { consistentPersonalRaw } from '../canonical/legacy.fixture.ts'
import type { CanonicalData } from '../canonical/types.ts'
import { readV2 } from '../canonical/v2Reader.ts'
import { stableStringify } from '../derive/baseline.ts'
import { diffJson } from './jsonDiff.ts'
import { plan } from './migration.fixture.ts'
import { baselineOf, mapCanonicalBack, mapUuidsBack, shadowCompare } from './shadowCompare.ts'

const setup = () => {
  const result = plan(consistentPersonalRaw())
  assert.equal(result.report.canApply, true)
  const read = readV2(JSON.parse(JSON.stringify(result.files)))
  const { applied, oldIdOf } = result.canonical
  const uuidOf = new Map([...oldIdOf].map(([uuid, oldId]) => [oldId, uuid]))
  return { applied, read, oldIdOf, uuidOf }
}

const tampered = (read: CanonicalData, change: (copy: CanonicalData) => void) => {
  const copy = structuredClone(read)
  change(copy)
  return copy
}

test('未篡改：两层都通过；运行时字段（source）不同不算差异', () => {
  const { applied, read, oldIdOf } = setup()
  assert.equal(applied.travel.source, 'local')
  assert.equal(read.wantToGo.source, 'local')
  const result = shadowCompare({ expected: { ...applied, wantToGo: { ...applied.wantToGo, source: 'sample' } }, actual: read, oldIdOf })
  assert.deepEqual(result.canonical, { equal: true, total: 0, paths: [] })
  assert.deepEqual(result.derived, { equal: true, total: 0, paths: [] })
})

test('篡改一个地点的名称：Canonical 层指向该地点，派生层也报差异', () => {
  const { applied, read, oldIdOf, uuidOf } = setup()
  const reykjavik = uuidOf.get('iceland__reykjavik')!
  const index = read.places.findIndex((place) => place.id === reykjavik)
  const actual = tampered(read, (copy) => { copy.places[index].names.en = 'Reykjavík' })
  const result = shadowCompare({ expected: applied, actual, oldIdOf })
  assert.deepEqual(result.canonical.paths, [`$.places[${index}].names.en`])
  assert.equal(result.derived.equal, false)
  assert.ok(result.derived.paths.some((path) => path.includes('cityById.iceland__reykjavik.nameEn')), result.derived.paths.join('\n'))
})

test('篡改一条记录的 placeId：Canonical 层指向该记录，派生层也报差异', () => {
  const { applied, read, oldIdOf, uuidOf } = setup()
  const index = read.travel.records.findIndex((record) => record.id === 'sample_vik')
  const actual = tampered(read, (copy) => { copy.travel.records[index].placeId = uuidOf.get('iceland__akureyri')! })
  const result = shadowCompare({ expected: applied, actual, oldIdOf })
  assert.deepEqual(result.canonical.paths, [`$.records[${index}].placeId`])
  assert.equal(result.derived.equal, false)
  assert.ok(result.derived.paths.some((path) => path.startsWith('$.modules.travelAtlas.cities')), result.derived.paths.join('\n'))
})

test('篡改一个媒体项的地点：Canonical 层指向该媒体项，派生层也报差异', () => {
  const { applied, read, oldIdOf, uuidOf } = setup()
  const index = read.media.items.findIndex((item) => item.id === 'photo-reykjavik-1')
  const actual = tampered(read, (copy) => { copy.media.items[index].placeId = uuidOf.get('iceland__akureyri')! })
  const result = shadowCompare({ expected: applied, actual, oldIdOf })
  assert.deepEqual(result.canonical.paths, [`$.mediaItems[${index}].placeId`])
  assert.equal(result.derived.equal, false)
  assert.ok(result.derived.paths.some((path) => path.startsWith('$.modules.mediaCatalog')), result.derived.paths.join('\n'))
})

test('映射回旧 id：对象键与嵌在派生 id 里的 UUID 都换回；不认识的 UUID 原样留下；legacyKeys 去掉前缀', () => {
  const { applied, read, oldIdOf, uuidOf } = setup()
  const iceland = uuidOf.get('iceland')!
  const stranger = '019b76da-a8ff-7000-8000-0000000000ff'
  assert.deepEqual(
    mapUuidsBack({ [iceland]: [`place:country:${iceland}`, `country-order__${iceland}__${stranger}`] }, oldIdOf),
    { iceland: ['place:country:iceland', `country-order__iceland__${stranger}`] },
  )
  assert.deepEqual(mapCanonicalBack(read, oldIdOf).places, applied.places)

  // B 映射回去之后的基线与 A′ 逐字节相同。
  assert.equal(stableStringify(mapUuidsBack(baselineOf({ ...read, travel: { ...read.travel, source: applied.travel.source } }), oldIdOf)), stableStringify(baselineOf(applied)))
})

test('diffJson：只给路径不给值；undefined 的键视为不存在；超过上限只列前 N 处', () => {
  assert.deepEqual(diffJson({ a: 1, b: undefined, c: [1, 2] }, { a: 1, c: [1, 2] }), { equal: true, total: 0, paths: [] })
  assert.deepEqual(diffJson({ a: 'secret', 'x y': [1] }, { a: 'other', 'x y': [1, 2] }), { equal: false, total: 2, paths: ['$.a', '$["x y"][1]'] })
  const many = diffJson(Array.from({ length: 60 }, (_, index) => index), [], { limit: 3 })
  assert.equal(many.total, 60)
  assert.deepEqual(many.paths, ['$[0]', '$[1]', '$[2]'])
})
