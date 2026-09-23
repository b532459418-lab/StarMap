/**
 * slugify 的单元测试。规则必须与 scripts/want-to-go-store.mjs 的副本逐字一致，
 * 这里把几条会影响 EntityId 与 FR-MR-5 合并键的行为钉死。
 *
 * 下面这行 reference 不能删，理由同 adapters/travel.test.ts：
 * tsconfig.app.json 的 types 是 ["vite/client"]，不含 "node"。
 */

/// <reference types="node" />

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { slugify } from './slug.ts'

test('小写并把非字母数字折叠成单个连字符', () => {
  assert.equal(slugify('Reykjavik'), 'reykjavik')
  assert.equal(slugify('Faroe Islands'), 'faroe-islands')
  assert.equal(slugify('St. John\'s'), 'st-john-s')
})

test('去掉首尾连字符', () => {
  assert.equal(slugify('  --Nuuk--  '), 'nuuk')
})

test('NFKC 归一：全角字符与半角字符得到同一个 slug', () => {
  assert.equal(slugify('ＮＵＵＫ'), slugify('Nuuk'))
})

test('非拉丁字母保留（中文名也能产出非空 slug）', () => {
  assert.equal(slugify('雷克雅未克'), '雷克雅未克')
  assert.equal(slugify('Tromsø'), 'tromsø')
})

test('只有标点时产出空串', () => {
  assert.equal(slugify(' - / - '), '')
})
