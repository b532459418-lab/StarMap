/**
 * derive/wantToGo.ts 的单元测试（RFC-LOC-1 PR1 §3.5）。
 *
 * 运行方式：npm test。零依赖：Node 24 自带类型剥离，只用 node:test + node:assert/strict。
 * RFC-LOC-1 PR5b 删除了旧派生 `deriveWantToGo` 与它的用例；想去的派生由 ../canonical/derive.ts 做，
 * 由 ../canonical/derive.test.ts 覆盖。这里测想去卡片显示哪一条记录（RFC-LOC-1 Core-A）。「标记为去过」的前置条件
 * （planned 记录的坐标判断原来在这里测）已与写入端点合成一份规则，见 ../canonical/convertRules.test.ts（审查 C2）。
 *
 * 下面这行 reference 不能删，理由见 src/worldgraph/adapters/travel.test.ts 文件头。
 */

/// <reference types="node" />

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { PLANNED_SOURCE } from '../../worldgraph/adapters/plannedRecords.ts'
import { WANT_TO_GO_SOURCE } from '../../worldgraph/adapters/wantToGo.ts'
import type { LayerId, LayerMembership } from '../../worldgraph/types.ts'
import { wantToGoCardRecordOf } from './wantToGo.ts'

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
