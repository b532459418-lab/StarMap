/**
 * dataModeNotice（V2 数据模式的只读说明与空状态）的单元测试（RFC-LOC-1 PR3b-1 规格 §2.4）。
 *
 * 运行方式：npm test。零依赖：Node 24 自带类型剥离，只用 node:test + node:assert/strict。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { dataModeNotice, V2_EMPTY_NOTICE, V2_READ_ONLY_NOTICE } from './dataModeNotice.ts'

test('只在个人模式且数据模式为 v2 时显示；公开模式与旧模式下不显示（即使没有数据）', () => {
  for (const [personal, dataMode] of [[false, 'legacy'], [false, 'v2'], [true, 'legacy']] as const) {
    assert.equal(dataModeNotice({ personal, dataMode, travelRecordCount: 0, wantToGoItemCount: 0 }), undefined, `${personal} ${dataMode}`)
  }
})

test('个人模式 · v2：常驻只读说明；没有足迹记录也没有想去条目时另显示空状态', () => {
  assert.deepEqual(dataModeNotice({ personal: true, dataMode: 'v2', travelRecordCount: 0, wantToGoItemCount: 0 }), {
    readOnly: V2_READ_ONLY_NOTICE,
    empty: V2_EMPTY_NOTICE,
  })
  for (const [travelRecordCount, wantToGoItemCount] of [[1, 0], [0, 1], [5, 3]]) {
    assert.deepEqual(
      dataModeNotice({ personal: true, dataMode: 'v2', travelRecordCount, wantToGoItemCount }),
      { readOnly: V2_READ_ONLY_NOTICE },
      `${travelRecordCount} / ${wantToGoItemCount}`,
    )
  }
})

test('文案：只读说明与空状态（「从添加第一个城市开始」留到 PR3b-2）', () => {
  assert.equal(V2_READ_ONLY_NOTICE, '当前为 V2 数据模式（只读）：编辑功能将在后续版本开放。')
  assert.equal(V2_EMPTY_NOTICE, '还没有足迹。')
})
