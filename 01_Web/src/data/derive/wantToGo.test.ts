/**
 * derive/wantToGo.ts 的单元测试（RFC-LOC-1 PR1 §3.5）。
 *
 * 运行方式：npm test。零依赖：Node 24 自带类型剥离，只用 node:test + node:assert/strict。
 * RFC-LOC-1 PR5b 删除了旧派生 `deriveWantToGo` 与它的用例；想去的派生由 ../canonical/derive.ts 做，
 * 由 ../canonical/derive.test.ts 覆盖。这里只剩 planned 记录的转换前置条件。
 *
 * 下面这行 reference 不能删，理由见 src/worldgraph/adapters/travel.test.ts 文件头。
 */

/// <reference types="node" />

import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { TravelMapRecord } from '../../types/travel.ts'
import { plannedConvertBlockReason } from './wantToGo.ts'

const planned = (id: string, extra: Partial<TravelMapRecord> = {}): TravelMapRecord => ({
  id,
  country: '挪威',
  country_en: 'Norway',
  city: id,
  city_en: id,
  start_date: '2026-07-01',
  status: 'planned',
  lat: 60,
  lng: 5,
  ...extra,
})

test('plannedConvertBlockReason：经纬度都是有限数才可转换', () => {
  assert.equal(plannedConvertBlockReason(planned('a')), undefined)
  assert.equal(plannedConvertBlockReason(planned('b', { lat: null })), '这条旅行计划没有坐标，无法转为足迹。')
  assert.equal(plannedConvertBlockReason(planned('c', { lng: Number.POSITIVE_INFINITY })), '这条旅行计划没有坐标，无法转为足迹。')
})
