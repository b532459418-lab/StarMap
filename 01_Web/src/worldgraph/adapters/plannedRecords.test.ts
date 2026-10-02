/**
 * plannedRecordsToWorldGraph 的单元测试（PRD FR-WTG-7；RFC-LOC-1 Core 方案 C1–C3）。
 *
 * 运行方式：npm test。零依赖：Node 24 自带类型剥离，只用 node:test + node:assert/strict。
 * fixture 手写，理由与 travel.test.ts 相同。
 *
 * 下面这行 reference 不能删，理由见 travel.test.ts 的同一段说明。
 */

/// <reference types="node" />

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { PLANNED_SOURCE, plannedRecordsToWorldGraph, type PlannedRecordInput } from './plannedRecords.ts'

const plannedNuuk = (): PlannedRecordInput => ({
  id: 'planned-nuuk',
  placeId: 'p-nuuk',
  start_date: '2027-06-01',
  notes: '冰岛之后的下一站',
})

const deepFreeze = <T>(value: T): T => {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key])
    }
    Object.freeze(value)
  }
  return value
}

test('空输入产出一个四个数组都为空的快照', () => {
  assert.deepEqual(plannedRecordsToWorldGraph([]), { entities: [], memberships: [], anchors: [], relations: [] })
})

test('planned 记录只产出只读的想去成员关系：entityId 是地点 id，recordId 是记录 id，逐字段正确', () => {
  assert.equal(PLANNED_SOURCE, 'travel-map:planned')
  assert.deepEqual(plannedRecordsToWorldGraph([plannedNuuk()]), {
    entities: [],
    memberships: [{
      entityId: 'p-nuuk',
      layerId: 'want_to_go',
      recordId: 'planned-nuuk',
      addedBy: 'rule',
      addedAt: '2027-06-01',
      metadata: { source: 'travel-map:planned', readOnly: true, note: '冰岛之后的下一站' },
    }],
    anchors: [],
    relations: [],
  })
})

test('没有备注（或备注为空串）时 metadata 里不出现 note 键', () => {
  const snapshot = plannedRecordsToWorldGraph([{ ...plannedNuuk(), notes: undefined }, { ...plannedNuuk(), id: 'planned-2', notes: '' }])
  assert.deepEqual(snapshot.memberships.map((membership) => membership.metadata), [
    { source: PLANNED_SOURCE, readOnly: true },
    { source: PLANNED_SOURCE, readOnly: true },
  ])
})

test('同一地点的多条 planned 记录各自一条成员关系；同一个 record id 出现两次时第一条胜出', () => {
  const again: PlannedRecordInput = { id: 'planned-nuuk-2028', placeId: 'p-nuuk', start_date: '2028-06-01' }
  const duplicate: PlannedRecordInput = { ...plannedNuuk(), placeId: 'p-elsewhere' }
  const snapshot = plannedRecordsToWorldGraph([plannedNuuk(), again, duplicate])
  assert.deepEqual(
    snapshot.memberships.map((membership) => [membership.entityId, membership.recordId]),
    [['p-nuuk', 'planned-nuuk'], ['p-nuuk', 'planned-nuuk-2028']],
  )
})

test('纯函数：不修改输入，相同输入产出逐字段相同的快照', () => {
  const records = deepFreeze([plannedNuuk()])
  assert.deepEqual(plannedRecordsToWorldGraph(records), plannedRecordsToWorldGraph(records))
  assert.deepEqual(records, [plannedNuuk()])
})
