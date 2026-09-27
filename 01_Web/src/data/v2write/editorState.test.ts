/**
 * `/editor/state` 在 V2 下的 V1 ↔ V2 转换（v2write/editorState.ts）的单元测试（RFC-LOC-1 PR3b-2 规格 §2.3、§3）。
 *
 * 运行方式：npm test。零依赖：Node 24 自带类型剥离，只用 node:test + node:assert/strict。
 */

/// <reference types="node" />

import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { V2Files } from '../canonical/v2Schema.ts'
import type { TravelAtlasEditorState } from '../derive/editorState.ts'
import { putEditorState, readEditorStateV1 } from './editorState.ts'
import { V2WriteError } from './errors.ts'
import { WRITE_NOW, applyWrites, assertIntact, migratedFiles, placeNamed, testContext, writeOrder } from './v2write.fixture.ts'

const assertV2Error = (run: () => unknown, code: string, check?: (error: V2WriteError) => void) => {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof V2WriteError, String(error))
    assert.equal(error.code, code, error.message)
    check?.(error)
    return true
  })
}

const GHOST = '019b76da-ffff-7000-8000-00000000ffff'

/** 迁移后的数据，另有一个手动添加的国家（日本，只在 editor-state 里）。 */
const filesWithAddedCountry = (): V2Files => {
  const files = migratedFiles()
  const japan = '019b76da-a8ff-7000-8000-0000000000ff'
  files.places.places.push({ id: japan, subtype: 'country', names: { 'zh-Hans': '日本', en: 'Japan' }, externalIds: { iso3166Alpha2: 'JP' }, location: { lat: 36, lng: 138 } })
  files.editorState.addedCountries = [{ placeId: japan, region: 'Asia', visitedDate: '2024-04-01' }]
  files.editorState.countryOrder = [japan, ...files.editorState.countryOrder]
  return files
}

// ---------------------------------------------------------------------------
// GET
// ---------------------------------------------------------------------------

test('GET：V2 editor-state 转成 V1 形状；id 是地点 id；addedCountries 的名称、代码、中心坐标取自地点', () => {
  const files = filesWithAddedCountry()
  const state = readEditorStateV1(files, WRITE_NOW)
  assert.equal(state.schemaVersion, 1)
  assert.deepEqual(state.countryOrder, files.editorState.countryOrder)
  assert.deepEqual(state.hiddenCityIds, [placeNamed(files, 'Vik').id])
  assert.deepEqual(state.coverMediaByCity, { [placeNamed(files, 'Reykjavik').id]: 'photo-reykjavik-2' })
  assert.deepEqual(state.addedCountries, [{
    id: '019b76da-a8ff-7000-8000-0000000000ff',
    nameZh: '日本',
    nameEn: 'Japan',
    countryCode: 'jp',
    centerLat: 36,
    centerLng: 138,
    region: 'Asia',
    visitedDate: '2024-04-01',
  }])
  assert.equal(state.updatedAt, '2026-09-01T00:00:00.000Z')
})

test('GET：全新 V2 目录（没有任何文件）→ 空的 V1 状态；现有文件不合法 → E_INTEGRITY', () => {
  const state = readEditorStateV1(undefined, WRITE_NOW)
  assert.deepEqual({ ...state, updatedAt: undefined }, {
    schemaVersion: 1, addedCountries: [], countryOrder: [], hiddenCountryIds: [], cityOrderByCountry: {}, hiddenCityIds: [],
    mediaOrderByCity: {}, hiddenMediaIds: [], coverMediaByCity: {}, droneOrderByCity: {}, hiddenDroneMediaIds: [], updatedAt: undefined,
  })
  const broken = migratedFiles()
  broken.editorState.hiddenCountryIds = [GHOST]
  assertV2Error(() => readEditorStateV1(broken, WRITE_NOW), 'E_INTEGRITY')
})

// ---------------------------------------------------------------------------
// PUT
// ---------------------------------------------------------------------------

/** 模拟客户端：GET → 改 → PUT。 */
const clientPut = (files: V2Files, update: (current: TravelAtlasEditorState) => unknown) =>
  putEditorState(files, update(readEditorStateV1(files, WRITE_NOW)), testContext())

test('PUT：调换国家顺序、隐藏一个城市——只写 editor-state；返回 V1 形状；updatedAt 为这次写入的时间', () => {
  const files = migratedFiles()
  const iceland = placeNamed(files, 'Iceland').id
  const faroe = placeNamed(files, 'Faroe Islands').id
  const gjogv = placeNamed(files, 'Gjogv').id
  const outcome = clientPut(files, (current) => ({
    ...current,
    countryOrder: [iceland, faroe],
    hiddenCityIds: [...current.hiddenCityIds, gjogv],
    cityOrderByCountry: { [faroe]: [placeNamed(files, 'Klaksvik').id, placeNamed(files, 'Torshavn').id] },
  }))
  assert.deepEqual(writeOrder(outcome.writes), ['editorState'])
  const next = applyWrites(files, outcome.writes)
  assertIntact(next)
  assert.deepEqual(next.editorState.countryOrder, [iceland, faroe])
  assert.deepEqual(next.editorState.hiddenCityIds, [placeNamed(files, 'Vik').id, gjogv])
  assert.equal(next.editorState.schemaVersion, 2)
  assert.equal(next.editorState.updatedAt, WRITE_NOW.toISOString())
  assert.equal(outcome.result.state.schemaVersion, 1)
  assert.deepEqual(outcome.result.state.countryOrder, [iceland, faroe])
  assert.equal(outcome.result.state.updatedAt, WRITE_NOW.toISOString())
})

test('PUT：GET 回来原样 PUT，V2 文件除 updatedAt 外不变（V1 ↔ V2 往返）', () => {
  const files = filesWithAddedCountry()
  const outcome = clientPut(files, (current) => current)
  const next = applyWrites(files, outcome.writes)
  assert.deepEqual({ ...next.editorState, updatedAt: undefined }, { ...files.editorState, updatedAt: undefined })
})

test('PUT：addedCountries 以服务端为准，客户端带回的副本（删掉、改名、另加）一律忽略；绝不把客户端对象原样写进文件', () => {
  const files = filesWithAddedCountry()
  const outcome = clientPut(files, (current) => ({
    ...current,
    addedCountries: [{ ...current.addedCountries[0], nameZh: '被客户端改掉', countryCode: 'xx' }, { id: GHOST, nameZh: '伪造', nameEn: 'Fake', countryCode: 'ff', centerLat: 0, centerLng: 0 }],
    unknownField: 'should not be written',
    schemaVersion: 1,
  }))
  const next = applyWrites(files, outcome.writes)
  assert.deepEqual(next.editorState.addedCountries, files.editorState.addedCountries)
  assert.equal(Object.hasOwn(next.editorState, 'unknownField'), false)
  assert.equal(outcome.result.state.addedCountries[0].nameZh, '日本')

  const cleared = applyWrites(files, clientPut(files, (current) => ({ ...current, addedCountries: [] })).writes)
  assert.deepEqual(cleared.editorState.addedCountries, files.editorState.addedCountries)
})

test('PUT：媒体 id 原样写（不核对媒体目录）', () => {
  const files = migratedFiles()
  const reykjavik = placeNamed(files, 'Reykjavik').id
  const outcome = clientPut(files, (current) => ({
    ...current,
    mediaOrderByCity: { [reykjavik]: ['photo-reykjavik-2', 'photo-reykjavik-1', 'not-in-catalog'] },
    hiddenMediaIds: ['photo-reykjavik-1'],
    hiddenDroneMediaIds: ['drone-whatever'],
  }))
  const next = applyWrites(files, outcome.writes)
  assert.deepEqual(next.editorState.mediaOrderByCity, { [reykjavik]: ['photo-reykjavik-2', 'photo-reykjavik-1', 'not-in-catalog'] })
  assert.deepEqual(next.editorState.hiddenMediaIds, ['photo-reykjavik-1'])
  assert.deepEqual(next.editorState.hiddenDroneMediaIds, ['drone-whatever'])
})

test('PUT：地点 id 不存在或类型不对 → E_UNKNOWN_PLACE_REF（400 的错误），不写', () => {
  const files = migratedFiles()
  const iceland = placeNamed(files, 'Iceland').id
  const reykjavik = placeNamed(files, 'Reykjavik').id
  const cases: [string, (current: TravelAtlasEditorState) => unknown, Record<string, unknown>][] = [
    ['countryOrder 里是不存在的地点', (current) => ({ ...current, countryOrder: [GHOST] }), { field: 'countryOrder', id: GHOST, expected: 'country', actual: 'missing' }],
    ['countryOrder 里是城市', (current) => ({ ...current, countryOrder: [reykjavik] }), { field: 'countryOrder', expected: 'country', actual: 'city' }],
    ['hiddenCountryIds 里是城市', (current) => ({ ...current, hiddenCountryIds: [reykjavik] }), { field: 'hiddenCountryIds' }],
    ['cityOrderByCountry 的键是城市', (current) => ({ ...current, cityOrderByCountry: { [reykjavik]: [] } }), { field: 'cityOrderByCountry' }],
    ['cityOrderByCountry 的值是国家', (current) => ({ ...current, cityOrderByCountry: { [iceland]: [iceland] } }), { field: `cityOrderByCountry.${iceland}` }],
    ['hiddenCityIds 里是国家', (current) => ({ ...current, hiddenCityIds: [iceland] }), { field: 'hiddenCityIds', actual: 'country' }],
    ['mediaOrderByCity 的键是国家', (current) => ({ ...current, mediaOrderByCity: { [iceland]: [] } }), { field: 'mediaOrderByCity' }],
    ['coverMediaByCity 的键不存在', (current) => ({ ...current, coverMediaByCity: { [GHOST]: 'x' } }), { field: 'coverMediaByCity' }],
    ['droneOrderByCity 的键是旧键', (current) => ({ ...current, droneOrderByCity: { 'faroe-islands__torshavn': [] } }), { field: 'droneOrderByCity', actual: 'missing' }],
  ]
  for (const [name, update, params] of cases) {
    assertV2Error(() => clientPut(files, update), 'E_UNKNOWN_PLACE_REF', (error) => {
      for (const [key, value] of Object.entries(params)) assert.equal(error.params?.[key], value, `${name} · ${key}`)
      assert.equal(error.message, '编辑状态引用了不存在的地点，或地点类型不对，未保存。请刷新页面后重试。')
    })
  }
})

test('PUT：请求体不是对象、字段缺失或形状不对 → E_EDITOR_STATE_INVALID（沿用「编辑状态格式无效。」）', () => {
  const files = migratedFiles()
  const current = readEditorStateV1(files, WRITE_NOW)
  const bodies: [unknown, string][] = [
    [null, '$'],
    [[], '$'],
    ['state', '$'],
    [{ ...current, countryOrder: undefined }, 'countryOrder'],
    [{ ...current, hiddenCityIds: [1] }, 'hiddenCityIds'],
    [{ ...current, cityOrderByCountry: [] }, 'cityOrderByCountry'],
    [{ ...current, coverMediaByCity: { x: ['a'] } }, 'coverMediaByCity'],
    [{ ...current, mediaOrderByCity: { x: 'a' } }, 'mediaOrderByCity'],
    [{ ...current, hiddenDroneMediaIds: 'a' }, 'hiddenDroneMediaIds'],
  ]
  for (const [body, field] of bodies) {
    assertV2Error(() => putEditorState(files, body, testContext()), 'E_EDITOR_STATE_INVALID', (error) => {
      assert.equal(error.params?.field, field)
      assert.equal(error.message, '编辑状态格式无效。')
    })
  }
})

test('PUT：全新 V2 目录 → 只写 editor-state，合法', () => {
  const outcome = putEditorState(undefined, readEditorStateV1(undefined, WRITE_NOW), testContext())
  assert.deepEqual(writeOrder(outcome.writes), ['editorState'])
  assertIntact(applyWrites({}, outcome.writes))
})

test('PUT：完整性——现有文件里有悬空引用 → E_INTEGRITY（入口检查），不给出写入', () => {
  const files = migratedFiles()
  files.travel.display.navigationHiddenCityIds = [GHOST]
  const current = readEditorStateV1(migratedFiles(), WRITE_NOW)
  assertV2Error(() => putEditorState(files, current, testContext()), 'E_INTEGRITY')
})
