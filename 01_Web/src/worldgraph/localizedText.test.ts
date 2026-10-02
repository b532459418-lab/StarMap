/**
 * localizedText.ts 的单元测试（RFC-LOC-1 LOC-3 / LOC-5，Core-B 规格 §5）。
 *
 * 运行方式：npm test。零依赖：只用 node:test + node:assert/strict。
 * 下面这行 reference 不能删，理由见 adapters/travel.test.ts 的同一段说明。
 */

/// <reference types="node" />

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { copyLocalizedText, originalNameSubtitle, resolveName, searchableNames, type LocalizedText } from './localizedText.ts'

/** RFC LOC-5 的例子：《千与千寻》。 */
const spiritedAway = (): LocalizedText => ({
  names: { 'zh-Hans': '千与千寻', ja: '千と千尋の神隠し', en: 'Spirited Away' },
  originalLanguage: 'ja',
})

// ---------------------------------------------------------------------------
// LOC-5 的表格：六种界面的主标题与副标题
// ---------------------------------------------------------------------------

test('LOC-5：简中、繁中、日、英、韩、西六种界面的主标题与副标题', () => {
  const rows: [string, string, string | undefined][] = [
    ['zh-Hans', '千与千寻', '千と千尋の神隠し'],
    ['zh-Hant', '千与千寻', '千と千尋の神隠し'], // 没有 zh-Hant 名：第 3 步简繁互退
    ['ja', '千と千尋の神隠し', undefined], // 主标题就是原名：没有副标题
    ['en', 'Spirited Away', '千と千尋の神隠し'],
    ['ko', '千と千尋の神隠し', undefined], // 没有 ko 名：第 4 步中日韩界面原名优先
    ['es', 'Spirited Away', '千と千尋の神隠し'], // 没有 es 名：第 4 步其他界面英文优先
  ]
  for (const [uiLocale, title, subtitle] of rows) {
    assert.equal(resolveName(spiritedAway(), uiLocale), title, uiLocale)
    assert.equal(originalNameSubtitle(spiritedAway(), uiLocale), subtitle, uiLocale)
  }
})

// ---------------------------------------------------------------------------
// 五步的补充用例
// ---------------------------------------------------------------------------

test('第 0 步 + 第 3 步：zh-TW 界面（补全为 zh-Hant-TW）只有 zh-Hans 名时取简体名', () => {
  const text: LocalizedText = { names: { 'zh-Hans': '京都', en: 'Kyoto' } }
  assert.equal(resolveName(text, 'zh-TW'), '京都')
  assert.equal(resolveName(text, 'zh-HK'), '京都')
  // 反方向：简体界面只有繁体名。
  assert.equal(resolveName({ names: { 'zh-Hant': '東京', en: 'Tokyo' } }, 'zh-CN'), '東京')
})

test('第 0 步 + 第 1 步：zh-CN 界面精确匹配 zh-Hans 名（补全后都是 zh-Hans-CN）', () => {
  const text: LocalizedText = { names: { 'zh-Hans': '京都', 'zh-Hant': '京都（繁）', en: 'Kyoto' } }
  assert.equal(resolveName(text, 'zh-CN'), '京都')
  assert.equal(resolveName(text, 'zh-TW'), '京都（繁）')
})

test('第 2 步：es-MX 界面取 es 名（去掉地区、保留书写系统）', () => {
  const text: LocalizedText = { names: { es: 'Ciudad de México', en: 'Mexico City' } }
  assert.equal(resolveName(text, 'es-MX'), 'Ciudad de México')
  assert.equal(resolveName({ names: { 'en-GB': 'Colour', fr: 'Couleur' } }, 'en-US'), 'Colour')
})

test('第 4 步：中日韩界面原名优先，其他界面英文优先', () => {
  const tokyo: LocalizedText = { names: { ja: '東京', en: 'Tokyo' }, originalLanguage: 'ja' }
  assert.equal(resolveName(tokyo, 'zh-Hans'), '東京')
  assert.equal(resolveName(tokyo, 'ko'), '東京')
  assert.equal(resolveName(tokyo, 'de'), 'Tokyo')
  assert.equal(resolveName(tokyo, 'fr-CA'), 'Tokyo')
  // 没有原名时，中日韩界面也回落到英文；没有英文时，其他界面回落到原名。
  assert.equal(resolveName({ names: { fr: 'Paris (fr)', en: 'Paris' } }, 'ko'), 'Paris')
  assert.equal(resolveName({ names: { ja: '大阪', 'zh-Hans': '大阪（简）' }, originalLanguage: 'ja' }, 'de'), '大阪')
  // 「英文」优先正好是 en 的键，其次按码点序取语言为 en 的键。
  assert.equal(resolveName({ names: { 'en-US': 'Color', en: 'Colour', fr: 'Couleur' } }, 'de'), 'Colour')
  assert.equal(resolveName({ names: { 'en-US': 'Color', 'en-GB': 'Colour', fr: 'Couleur' } }, 'de'), 'Colour')
})

test('只有 und：第 1–4 步都不参加，第 5 步兜底', () => {
  const text: LocalizedText = { names: { und: '2025 North Atlantic Demo' } }
  for (const uiLocale of ['zh-Hans', 'en', 'ja', 'es']) assert.equal(resolveName(text, uiLocale), '2025 North Atlantic Demo', uiLocale)
  // und 补全后会变成 en-Latn-US，但不能被英文界面当成英文名：有 en 时取 en，没有 en 时也不在第 1 步匹配到 und。
  assert.equal(resolveName({ names: { und: '未定', ja: '日本語' }, originalLanguage: 'ja' }, 'en'), '日本語')
  assert.equal(originalNameSubtitle(text, 'en'), undefined)
})

test('空 names、全是空字符串：主标题为空串，没有副标题，没有可搜索的名称', () => {
  assert.equal(resolveName({ names: {} }, 'zh-Hans'), '')
  assert.equal(resolveName({ names: { en: '', 'zh-Hans': '' } }, 'en'), '')
  assert.equal(originalNameSubtitle({ names: {}, originalLanguage: 'ja' }, 'en'), undefined)
  assert.deepEqual(searchableNames({ names: {} }), [])
})

test('无法解析的标签只参加第 5 步；界面语言无法解析时从第 4 步按其他界面开始', () => {
  const text: LocalizedText = { names: { zh_Hans: '下划线', en: 'English' } }
  assert.equal(resolveName(text, 'zh-Hans'), 'English', '第 4 步：中文界面没有原名，取英文')
  assert.equal(resolveName({ names: { zh_Hans: '下划线' } }, 'zh-Hans'), '下划线', '第 5 步兜底')
  // 原名的键无法解析：不算原名，不出副标题。
  assert.equal(resolveName({ names: { 'not a tag': '原名', en: 'English' }, originalLanguage: 'not a tag' }, 'ja'), 'English')
  assert.equal(originalNameSubtitle({ names: { 'not a tag': '原名', en: 'English' }, originalLanguage: 'not a tag' }, 'en'), undefined)
  // 界面语言无法解析：英文优先，再原名，再兜底。
  assert.equal(resolveName(spiritedAway(), 'not a tag'), 'Spirited Away')
  assert.equal(resolveName({ names: { ja: '東京' }, originalLanguage: 'ja' }, ''), '東京')
})

test('多个候选时结果稳定：第 2 步与第 5 步按标签码点序取第一个，与 names 的键顺序无关', () => {
  // 第 2 步：zh-Hans 界面（补全为 zh-Hans-CN），两个同为 Hans 但地区都不是 CN 的名称。
  const step2a: LocalizedText = { names: { 'zh-Hans-SG': '新加坡写法', 'zh-Hans-MY': '马来西亚写法', en: 'x' } }
  const step2b: LocalizedText = { names: { en: 'x', 'zh-Hans-MY': '马来西亚写法', 'zh-Hans-SG': '新加坡写法' } }
  assert.equal(resolveName(step2a, 'zh-Hans'), '马来西亚写法')
  assert.equal(resolveName(step2b, 'zh-Hans'), '马来西亚写法')
  // 第 2 步：候选里有地区与界面相同的，取它（等同第 1 步的精确匹配）。
  assert.equal(resolveName(step2a, 'zh-Hans-SG'), '新加坡写法')
  // 第 5 步：界面是德语，没有英文、没有原名。
  const step5a: LocalizedText = { names: { ja: '日本語', fr: 'Français', 'zh-Hans': '中文' } }
  const step5b: LocalizedText = { names: { 'zh-Hans': '中文', fr: 'Français', ja: '日本語' } }
  assert.equal(resolveName(step5a, 'de'), 'Français')
  assert.equal(resolveName(step5b, 'de'), 'Français')
})

test('值为空字符串的键视为不存在', () => {
  const text: LocalizedText = { names: { 'zh-Hans': '', ja: '東京', en: 'Tokyo' }, originalLanguage: 'ja' }
  assert.equal(resolveName(text, 'zh-Hans'), '東京', '空的 zh-Hans 不参加第 1 步')
  const emptyOriginal: LocalizedText = { names: { ja: '', en: 'Tokyo', 'zh-Hans': '东京' }, originalLanguage: 'ja' }
  assert.equal(resolveName(emptyOriginal, 'ko'), 'Tokyo', '原名为空：中日韩界面回落到英文')
  assert.equal(originalNameSubtitle(emptyOriginal, 'zh-Hans'), undefined)
  assert.deepEqual(searchableNames(text), ['Tokyo', '東京'])
})

// ---------------------------------------------------------------------------
// 副标题、搜索名称、复制
// ---------------------------------------------------------------------------

test('副标题：没有 originalLanguage（迁移来的地点）时没有副标题', () => {
  const kyoto: LocalizedText = { names: { 'zh-Hans': '京都', en: 'Kyoto' } }
  for (const uiLocale of ['zh-Hans', 'en', 'ja']) assert.equal(originalNameSubtitle(kyoto, uiLocale), undefined, uiLocale)
})

test('searchableNames：全部非空值，按标签码点序', () => {
  assert.deepEqual(searchableNames(spiritedAway()), ['Spirited Away', '千と千尋の神隠し', '千与千寻'])
  assert.deepEqual(searchableNames({ names: { und: 'B', en: 'A', 'zh-Hans': '' } }), ['A', 'B'])
})

test('纯函数：不修改输入；copyLocalizedText 不共享引用，originalLanguage 有才写', () => {
  const text = Object.freeze({ names: Object.freeze({ ...spiritedAway().names }), originalLanguage: 'ja' })
  resolveName(text, 'en')
  originalNameSubtitle(text, 'en')
  searchableNames(text)
  const copy = copyLocalizedText(text)
  assert.deepEqual(copy, text)
  assert.notEqual(copy, text)
  assert.notEqual(copy.names, text.names)
  assert.equal(Object.hasOwn(copyLocalizedText({ names: { en: 'x' } }), 'originalLanguage'), false)
})
