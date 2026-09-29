/**
 * dataModeNotice（V2 数据模式的空状态）的单元测试（RFC-LOC-1 PR3b-1 规格 §2.4；PR3b-2 规格 §2.7；PR3b-3 规格 §2.6）。
 *
 * 运行方式：npm test。零依赖：Node 24 自带类型剥离，只用 node:test + node:assert/strict。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import * as notices from './dataModeNotice.ts'
import { dataModeNotice, V2_EMPTY_NOTICE } from './dataModeNotice.ts'

test('只在个人模式且数据模式为 v2 时显示；公开模式与旧模式下不显示（即使没有数据）', () => {
  for (const [personal, dataMode] of [[false, 'legacy'], [false, 'v2'], [true, 'legacy']] as const) {
    assert.equal(dataModeNotice({ personal, dataMode, travelRecordCount: 0, wantToGoItemCount: 0 }), undefined, `${personal} ${dataMode}`)
  }
})

test('个人模式 · v2：没有足迹记录也没有想去条目时只显示空状态；有任何数据时什么都不显示（PR3b-3 去掉了只读说明）', () => {
  assert.deepEqual(dataModeNotice({ personal: true, dataMode: 'v2', travelRecordCount: 0, wantToGoItemCount: 0 }), { empty: V2_EMPTY_NOTICE })
  for (const [travelRecordCount, wantToGoItemCount] of [[1, 0], [0, 1], [5, 3]]) {
    assert.equal(
      dataModeNotice({ personal: true, dataMode: 'v2', travelRecordCount, wantToGoItemCount }),
      undefined,
      `${travelRecordCount} / ${wantToGoItemCount}`,
    )
  }
  assert.equal(Object.hasOwn(notices, 'V2_READ_ONLY_NOTICE'), false, '只读说明已删除')
})

test('文案：空状态为决定 E 的完整文案', () => {
  assert.equal(V2_EMPTY_NOTICE, '还没有足迹，从添加第一个城市开始。')
})
