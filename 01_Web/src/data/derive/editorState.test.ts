/**
 * editor-state 纯派生（derive/editorState.ts）的单元测试（RFC-LOC-1 PR1 §3.5）。
 * orderBySavedIds 的测试在 travelAtlas.test.ts（与它的使用处放在一起）。
 *
 * 运行方式：npm test。零依赖：Node 24 自带类型剥离，只用 node:test + node:assert/strict。
 *
 * 下面这行 reference 不能删，理由见 src/worldgraph/adapters/travel.test.ts 文件头。
 */

/// <reference types="node" />

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { deriveEditorState, emptyEditorState, parseEditorState } from './editorState.ts'

test('不是对象、或 schemaVersion 不是 1 时解析不出，派生结果是空状态（同一个对象）', () => {
  for (const value of [undefined, null, 'x', 1, {}, { schemaVersion: 2 }]) {
    assert.equal(parseEditorState(value), undefined)
    assert.equal(deriveEditorState(value), emptyEditorState)
  }
})

test('逐字段校验：形状不对的字段退回空值，addedCountries 只保留完整的国家', () => {
  const country = { id: 'zeta', nameZh: '泽塔', nameEn: 'Zeta', countryCode: 'ZE', centerLat: 1, centerLng: 2 }
  const parsed = parseEditorState({
    schemaVersion: 1,
    addedCountries: [country, { ...country, centerLat: '1' }, null],
    countryOrder: ['a', 'b'],
    hiddenCountryIds: ['a', 1],
    cityOrderByCountry: { a: ['a__x'], b: 'not-array' },
    hiddenCityIds: 'a__x',
    mediaOrderByCity: { a__x: ['m1'] },
    hiddenMediaIds: ['m2'],
    coverMediaByCity: { a__x: 'm1', a__y: 3 },
    droneOrderByCity: { a__x: ['d1'] },
    hiddenDroneMediaIds: ['d2'],
    updatedAt: 42,
    extra: 'ignored',
  })

  assert.deepEqual(parsed, {
    schemaVersion: 1,
    addedCountries: [country],
    countryOrder: ['a', 'b'],
    hiddenCountryIds: [],
    cityOrderByCountry: {},
    hiddenCityIds: [],
    mediaOrderByCity: { a__x: ['m1'] },
    hiddenMediaIds: ['m2'],
    coverMediaByCity: {},
    droneOrderByCity: { a__x: ['d1'] },
    hiddenDroneMediaIds: ['d2'],
    updatedAt: undefined,
  })
})

test('合法字段原样保留（同一个数组 / 对象引用），updatedAt 是字符串时保留', () => {
  const countryOrder = ['b', 'a']
  const parsed = deriveEditorState({ schemaVersion: 1, countryOrder, updatedAt: '2026-09-24T00:00:00.000Z' })
  assert.equal(parsed.countryOrder, countryOrder)
  assert.equal(parsed.updatedAt, '2026-09-24T00:00:00.000Z')
  assert.deepEqual(parsed.addedCountries, [])
})
