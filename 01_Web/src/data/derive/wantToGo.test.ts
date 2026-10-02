/**
 * derive/wantToGo.ts 的单元测试（RFC-LOC-1 PR1 §3.5）。
 *
 * 运行方式：npm test。零依赖：Node 24 自带类型剥离，只用 node:test + node:assert/strict。
 * RFC-LOC-1 PR5b 删除了旧派生 `deriveWantToGo` 与它的用例；想去的派生由 ../canonical/derive.ts 做，
 * 由 ../canonical/derive.test.ts 覆盖。这里测 planned 记录的转换前置条件，与想去卡片显示哪一条记录（RFC-LOC-1 Core-A）。
 *
 * 下面这行 reference 不能删，理由见 src/worldgraph/adapters/travel.test.ts 文件头。
 */

/// <reference types="node" />

import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { TravelMapRecord } from '../../types/travel.ts'
import { PLANNED_SOURCE } from '../../worldgraph/adapters/plannedRecords.ts'
import { WANT_TO_GO_SOURCE } from '../../worldgraph/adapters/wantToGo.ts'
import type { LayerId, LayerMembership } from '../../worldgraph/types.ts'
import { plannedConvertBlockReason, wantToGoCardRecordOf } from './wantToGo.ts'

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

// ---------------------------------------------------------------------------
// 想去卡片显示哪一条记录（RFC-LOC-1 Core-A §4.3）
// ---------------------------------------------------------------------------

const membership = (entityId: string, recordId: string | undefined, metadata: Record<string, unknown>, layerId: LayerId = 'want_to_go'): LayerMembership => ({
  entityId,
  layerId,
  ...(recordId === undefined ? {} : { recordId }),
  addedBy: 'user',
  addedAt: '2026-08-01',
  metadata,
})

const WTG = { hidden: false, source: WANT_TO_GO_SOURCE }
const PLANNED = { source: PLANNED_SOURCE, readOnly: true }

test('wantToGoCardRecordOf：有想去条目就取第一条想去条目，即使 planned 记录排在它前面', () => {
  const memberships = [
    membership('p-nuuk', undefined, {}, 'travel'),
    membership('p-nuuk', 'pl-nuuk', PLANNED),
    membership('p-other', 'w-other', WTG),
    membership('p-nuuk', 'w-nuuk', WTG),
    membership('p-nuuk', 'w-nuuk-2', WTG),
  ]
  assert.deepEqual(wantToGoCardRecordOf(memberships, 'p-nuuk'), { source: 'want-to-go', recordId: 'w-nuuk' })
})

test('wantToGoCardRecordOf：没有可见的想去条目时取第一条 planned 记录；隐藏的记录与足迹成员关系不算；都没有时为 undefined', () => {
  const memberships = [
    membership('p-nuuk', 'w-nuuk', { ...WTG, hidden: true }),
    membership('p-nuuk', 'pl-nuuk', PLANNED),
    membership('p-nuuk', 'pl-nuuk-2', PLANNED),
    membership('p-rvk', undefined, {}, 'travel'),
  ]
  assert.deepEqual(wantToGoCardRecordOf(memberships, 'p-nuuk'), { source: 'planned', recordId: 'pl-nuuk' })
  assert.equal(wantToGoCardRecordOf(memberships, 'p-rvk'), undefined)
  assert.equal(wantToGoCardRecordOf(memberships, 'p-missing'), undefined)
})
