/**
 * 同名城市的地点选择（./placeChoice.ts，第 2A 批）的单元测试：候选列表的解析、默认选中与输入指纹。
 *
 * 运行方式：npm test。零依赖：Node 24 自带类型剥离，只用 node:test + node:assert/strict。
 */

/// <reference types="node" />

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { LocalEditorError } from '../i18n/editorErrors.ts'
import { placeChoiceCandidatesOf, placeChoiceKey, placeChoiceNames, placeChoiceStateOf } from './placeChoice.ts'

const choiceError = (candidates: unknown) => new LocalEditorError({
  error: '找到可能是同一个地方的已有地点，请选择要使用的地点，或新建一个独立地点。本次尚未保存。',
  code: 'E_PLACE_CHOICE_REQUIRED',
  params: { subtype: 'city', countryId: 'country-cn', candidates },
})

const SUZHOU = { placeId: 'city-suzhou', names: { 'zh-Hans': '苏州', en: 'Suzhou' }, location: { lat: 31.3, lng: 120.59 }, distanceKm: 412.6, strong: false }

test('placeChoiceCandidatesOf：把 409 的候选交给界面（中英文名、距离、有没有坐标、是否强候选）', () => {
  assert.deepEqual(placeChoiceCandidatesOf(choiceError([
    SUZHOU,
    { placeId: 'city-no-location', names: { en: 'Suzhou' }, strong: false },
  ])), [
    { placeId: 'city-suzhou', nameZh: '苏州', nameEn: 'Suzhou', distanceKm: 412.6, hasLocation: true, strong: false },
    { placeId: 'city-no-location', nameEn: 'Suzhou', hasLocation: false, strong: false },
  ])
})

test('placeChoiceCandidatesOf：不是 E_PLACE_CHOICE_REQUIRED、或候选形状不对 → undefined（按普通错误显示）', () => {
  assert.equal(placeChoiceCandidatesOf(new Error('x')), undefined)
  assert.equal(placeChoiceCandidatesOf(new LocalEditorError({ code: 'E_CITY_EXISTS', params: { candidates: [SUZHOU] } })), undefined)
  for (const candidates of [
    undefined, [], 'x',
    [{ ...SUZHOU, placeId: '' }],
    [{ ...SUZHOU, strong: 'yes' }],
    [{ ...SUZHOU, names: {} }],
    [{ ...SUZHOU, names: { en: 3 } }],
    [{ ...SUZHOU, distanceKm: -1 }],
    [{ ...SUZHOU, distanceKm: Number.NaN }],
    [{ ...SUZHOU, location: { lat: 'north', lng: 1 } }],
    [SUZHOU, SUZHOU],
  ]) assert.equal(placeChoiceCandidatesOf(choiceError(candidates)), undefined, JSON.stringify(candidates))
})

test('placeChoiceStateOf：有强候选时默认选中第一个强候选；没有时不预选', () => {
  const weak = { placeId: 'a', nameEn: 'Suzhou', hasLocation: true, strong: false }
  const strong = { placeId: 'b', nameEn: 'Suzhou', hasLocation: true, strong: true }
  const strong2 = { placeId: 'c', nameEn: 'Suzhou', hasLocation: true, strong: true }
  assert.deepEqual(placeChoiceStateOf('k', [strong, strong2, weak]).selected, { kind: 'existing', placeId: 'b' })
  assert.equal(placeChoiceStateOf('k', [weak]).selected, undefined)
  assert.equal(Object.hasOwn(placeChoiceStateOf('k', [weak]), 'selected'), false)
})

test('placeChoiceKey / placeChoiceNames：输入变了指纹就变；中英文名相同时只显示一个', () => {
  assert.equal(placeChoiceKey(['cn', '苏州', 'Suzhou', 31.3, 120.59]), placeChoiceKey(['cn', '苏州', 'Suzhou', 31.3, 120.59]))
  assert.notEqual(placeChoiceKey(['cn', '苏州', 'Suzhou', 31.3, 120.59]), placeChoiceKey(['cn', '宿州', 'Suzhou', 31.3, 120.59]))
  assert.notEqual(placeChoiceKey(['cn', '苏州', 'Suzhou', 31.3, 120.59]), placeChoiceKey(['cn', '苏州', 'Suzhou', 31.3, 120.6]))
  assert.equal(placeChoiceNames({ nameZh: '苏州', nameEn: 'Suzhou' }), '苏州 / Suzhou')
  assert.equal(placeChoiceNames({ nameZh: '维克', nameEn: '维克' }), '维克')
  assert.equal(placeChoiceNames({ nameEn: 'Suzhou' }), 'Suzhou')
})
