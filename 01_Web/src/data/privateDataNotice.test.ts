/**
 * privateDataNotice（个人模式的迁移提示与空状态）的单元测试（RFC-LOC-1 PR3b-1 规格 §2.4；PR3b-2 规格 §2.7；PR3b-3 规格 §2.6；
 * PR5a 规格 §4.1、§5：数据模式删除，迁移提示优先于空状态）。
 *
 * 运行方式：npm test。零依赖：Node 24 自带类型剥离，只用 node:test + node:assert/strict。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import * as notices from './privateDataNotice.ts'
import { LEGACY_UNMIGRATED_NOTICE, privateDataNotice, V2_EMPTY_NOTICE } from './privateDataNotice.ts'

const EMPTY = { travelRecordCount: 0, wantToGoItemCount: 0 }

test('公开模式（以及读公开样例的强制样例）什么都不显示，即使没有数据', () => {
  for (const legacyUnmigrated of [false, true]) {
    assert.equal(privateDataNotice({ personal: false, legacyUnmigrated, ...EMPTY }), undefined, String(legacyUnmigrated))
  }
})

test('个人模式：没有足迹记录也没有想去条目时只显示空状态；有任何数据时什么都不显示（PR3b-3 去掉了只读说明）', () => {
  assert.deepEqual(privateDataNotice({ personal: true, legacyUnmigrated: false, ...EMPTY }), { kind: 'empty', lines: [V2_EMPTY_NOTICE] })
  for (const [travelRecordCount, wantToGoItemCount] of [[1, 0], [0, 1], [5, 3]]) {
    assert.equal(
      privateDataNotice({ personal: true, legacyUnmigrated: false, travelRecordCount, wantToGoItemCount }),
      undefined,
      `${travelRecordCount} / ${wantToGoItemCount}`,
    )
  }
  assert.equal(Object.hasOwn(notices, 'V2_READ_ONLY_NOTICE'), false, '只读说明已删除')
})

test('迁移提示优先于空状态（PR5a）：旧数据还没迁移时，没有数据也显示迁移提示而不是空状态；有数据时同样显示', () => {
  const expected = { kind: 'legacy-unmigrated', lines: LEGACY_UNMIGRATED_NOTICE }
  assert.deepEqual(privateDataNotice({ personal: true, legacyUnmigrated: true, ...EMPTY }), expected)
  assert.deepEqual(privateDataNotice({ personal: true, legacyUnmigrated: true, travelRecordCount: 2, wantToGoItemCount: 1 }), expected)
})

test('文案：空状态为决定 E 的完整文案；迁移提示说明旧数据没迁移、用提交 4fd32a9 迁移（步骤见 README）与放弃旧数据的做法，不含数据模式与已删除命令的说法', () => {
  assert.equal(V2_EMPTY_NOTICE, '还没有足迹，从添加第一个城市开始。')
  const text = LEGACY_UNMIGRATED_NOTICE.join('\n')
  assert.match(LEGACY_UNMIGRATED_NOTICE[0], /^私人目录里有旧格式的数据，还没有迁移。/)
  assert.ok(text.includes('请先检出 StarMap 的提交 4fd32a9（最后一个带迁移工具的版本）完成迁移'), text)
  assert.ok(text.includes('步骤见 README 的 Private Data Format 一节'), text)
  assert.equal(LEGACY_UNMIGRATED_NOTICE.length, 3, '界面提示保持简短：完整步骤只在 README')
  for (const name of ['travel-map', 'want-to-go', 'editor-state', 'user-media']) assert.ok(text.includes(name), name)
  assert.ok(text.includes('.local.json'))
  assert.doesNotMatch(text, /identity:check|数据模式|data-mode|--switch/)
  assert.ok(Object.isFrozen(LEGACY_UNMIGRATED_NOTICE))
})
