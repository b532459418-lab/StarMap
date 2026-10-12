/**
 * 同名行程的选择（./journeyChoice.ts，第 2C 批）的单元测试：候选行程的解析、不预选、提交的选择、输入指纹与日期范围。
 *
 * 运行方式：npm test。零依赖：Node 24 自带类型剥离，只用 node:test + node:assert/strict。
 */

/// <reference types="node" />

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { LocalEditorError } from '../i18n/editorErrors.ts'
import { journeyChoiceCandidatesOf, journeyChoiceInput, journeyChoiceKey, journeyChoiceStateOf, journeyDateRange } from './journeyChoice.ts'

const choiceError = (candidates: unknown) => new LocalEditorError({
  error: '已有同名的行程，请选择加入已有行程，或新建一个行程。本次尚未保存。',
  code: 'E_JOURNEY_CHOICE_REQUIRED',
  params: { tripTitle: '暑假', candidates },
})

const SUMMER_2024 = {
  journeyId: 'journey-2024',
  title: '暑假',
  startDate: '2024-07-01',
  endDate: '2024-07-10',
  cities: [
    { placeId: 'city-tokyo', names: { 'zh-Hans': '东京', en: 'Tokyo' } },
    { placeId: 'city-osaka', names: { en: 'Osaka' } },
  ],
  cityCount: 2,
}

test('journeyChoiceCandidatesOf：把 409 的候选行程交给界面（标题、日期范围、城市的中英文名、城市总数）', () => {
  assert.deepEqual(journeyChoiceCandidatesOf(choiceError([
    SUMMER_2024,
    { journeyId: 'journey-undated', title: '暑假', cities: [], cityCount: 7 },
  ])), [
    {
      journeyId: 'journey-2024',
      title: '暑假',
      startDate: '2024-07-01',
      endDate: '2024-07-10',
      cities: [{ placeId: 'city-tokyo', nameZh: '东京', nameEn: 'Tokyo' }, { placeId: 'city-osaka', nameEn: 'Osaka' }],
      cityCount: 2,
    },
    { journeyId: 'journey-undated', title: '暑假', cities: [], cityCount: 7 },
  ])
})

test('journeyChoiceCandidatesOf：不是 E_JOURNEY_CHOICE_REQUIRED、或候选形状不对 → undefined（按普通错误显示）', () => {
  assert.equal(journeyChoiceCandidatesOf(new Error('x')), undefined)
  assert.equal(journeyChoiceCandidatesOf(new LocalEditorError({ code: 'E_PLACE_CHOICE_REQUIRED', params: { candidates: [SUMMER_2024] } })), undefined)
  for (const candidates of [
    undefined, [], 'x',
    [{ ...SUMMER_2024, journeyId: '' }],
    [{ ...SUMMER_2024, title: ' ' }],
    [{ ...SUMMER_2024, title: undefined }],
    [{ ...SUMMER_2024, startDate: 20240701 }],
    [{ ...SUMMER_2024, cities: 'Tokyo' }],
    [{ ...SUMMER_2024, cities: [{ placeId: '', names: {} }] }],
    [{ ...SUMMER_2024, cities: [{ placeId: 'city-x', names: { en: 3 } }] }],
    [{ ...SUMMER_2024, cityCount: 1 }],
    [{ ...SUMMER_2024, cityCount: 2.5 }],
    [SUMMER_2024, SUMMER_2024],
  ]) assert.equal(journeyChoiceCandidatesOf(choiceError(candidates)), undefined, JSON.stringify(candidates))
})

test('journeyChoiceStateOf / journeyChoiceInput：不预选；选了已有行程提交 journeyId，选了新建提交 newJourney: true，没选什么都不带', () => {
  const candidates = journeyChoiceCandidatesOf(choiceError([SUMMER_2024]))!
  const state = journeyChoiceStateOf('k', candidates)
  assert.equal(Object.hasOwn(state, 'selected'), false)
  assert.deepEqual(journeyChoiceInput(undefined), {})
  assert.deepEqual(journeyChoiceInput({ kind: 'existing', journeyId: 'journey-2024' }), { journeyId: 'journey-2024' })
  assert.deepEqual(journeyChoiceInput({ kind: 'new' }), { newJourney: true })
})

test('journeyChoiceKey / journeyDateRange：标题变了指纹就变；同一年只写结束的月日，跨年照写，一天或只有一端时只写一个日期', () => {
  assert.equal(journeyChoiceKey(['暑假']), journeyChoiceKey(['暑假']))
  assert.notEqual(journeyChoiceKey(['暑假']), journeyChoiceKey(['寒假']))
  assert.notEqual(journeyChoiceKey(['k', { kind: 'new' }]), journeyChoiceKey(['k', { kind: 'existing', placeId: 'a' }]))
  assert.deepEqual(journeyDateRange('2024-07-01', '2024-07-10'), { from: '2024-07-01', to: '07-10' })
  assert.deepEqual(journeyDateRange('2024-12-28', '2025-01-03'), { from: '2024-12-28', to: '2025-01-03' })
  assert.deepEqual(journeyDateRange('2024-07-01', '2024-07-01'), { from: '2024-07-01' })
  assert.deepEqual(journeyDateRange('2024', '2024-07-01'), { from: '2024', to: '2024-07-01' })
  assert.deepEqual(journeyDateRange(undefined, '2024-07-01'), { from: '2024-07-01' })
  assert.deepEqual(journeyDateRange(undefined, undefined), {})
})
