/**
 * localizedText.ts 的单元测试（RFC-LOC-1 LOC-3 / LOC-5，Core-B 规格 §5）。
 *
 * 运行方式：npm test。零依赖：只用 node:test + node:assert/strict。
 * 下面这行 reference 不能删，理由见 adapters/travel.test.ts 的同一段说明。
 */

/// <reference types="node" />

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  copyLocalizedText,
  maximizeTagCacheForTests as cache,
  originalNameSubtitle,
  resolveName,
  searchableNames,
  type LocalizedText,
} from './localizedText.ts'

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

// ---------------------------------------------------------------------------
// 第 0 步的缓存（第 5A 批 P2）
// ---------------------------------------------------------------------------

/** 2fd9866 上不带缓存的第 0 步原样：用来对照缓存给出的结果。 */
const uncachedMaximize = (tag: string) => {
  let locale: Intl.Locale
  try {
    locale = new Intl.Locale(tag)
  } catch {
    return undefined
  }
  if (!locale.language || locale.language === 'und') return undefined
  const maximized = locale.maximize()
  return { tag, language: maximized.language, script: maximized.script, region: maximized.region }
}

/** 固定种子的伪随机数（mulberry32）：每次运行生成同一组随机标签。 */
const seededRandom = (seed: number): (() => number) => {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = Math.imul(state ^ (state >>> 15), 1 | state)
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

/** 随机标签：合法的组合、非法的写法、大小写变体、下划线分隔。 */
const randomTags = (random: () => number, count: number): string[] => {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]
  const languages = ['zh', 'ja', 'ko', 'en', 'es', 'fr', 'de', 'pt', 'ru', 'ar', 'sr', 'yue', 'und', 'zz', 'x', 'e', 'abcdefghi', '1', '']
  const scripts = ['Hans', 'Hant', 'Latn', 'Cyrl', 'Jpan', 'Kore', 'Zzzz', 'Han']
  const regions = ['CN', 'TW', 'HK', 'SG', 'US', 'GB', 'MX', '419', 'JP', 'XX', 'C']
  const odd = ['', ' ', 'zh--CN', 'en-', '-en', '123', 'i-klingon', 'en-US-u-ca-gregory', 'zh-Hans-CN-x-private', 'x-private', 'root', 'not a tag', 'ZH-HANS-CN', 'Zh-hAnT-tW']
  const recase = (value: string): string => {
    const mode = random()
    if (mode < 0.6) return value
    if (mode < 0.75) return value.toUpperCase()
    if (mode < 0.9) return value.toLowerCase()
    return Array.from(value, (char) => (random() < 0.5 ? char.toUpperCase() : char.toLowerCase())).join('')
  }
  return Array.from({ length: count }, () => {
    if (random() < 0.2) return pick(odd)
    const parts = [pick(languages)]
    if (random() < 0.5) parts.push(pick(scripts))
    if (random() < 0.5) parts.push(pick(regions))
    return recase(parts.join(random() < 0.9 ? '-' : '_'))
  })
}

test('第 0 步缓存：随机标签（合法、非法、大小写变体）的补全结果与不带缓存时相同；命中返回同一个值；解析失败也缓存', () => {
  cache.clear()
  const tags = randomTags(seededRandom(0x5a), 400)
  for (const tag of tags) {
    const first = cache.maximize(tag)
    assert.deepEqual(first, uncachedMaximize(tag), tag)
    assert.equal(cache.maximize(tag), first, `命中：${tag}`)
  }
  assert.ok(tags.some((tag) => uncachedMaximize(tag) === undefined), '随机标签里有不能解析的')
  assert.ok(tags.some((tag) => uncachedMaximize(tag) !== undefined), '随机标签里有能解析的')
  assert.equal(cache.size(), new Set(tags).size, '每个不同的标签一条，不能解析的也算')
})

test('resolveName / originalNameSubtitle：缓存冷（每次调用前清空）与缓存热时结果相同，覆盖随机名称与随机界面语言', () => {
  const random = seededRandom(0x5b)
  const pool = randomTags(random, 200)
  const locales = [...randomTags(random, 15), 'zh-Hans', 'zh-Hant', 'zh-CN', 'zh-TW', 'ja', 'ko', 'en', 'en-US', 'es-MX', 'de', 'und', '', 'not a tag']
  const pickFrom = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]
  const texts: LocalizedText[] = [spiritedAway(), { names: { 'zh-Hans': '京都', 'zh-Hant': '京都（繁）', en: 'Kyoto' } }]
  for (let index = 0; index < 100; index += 1) {
    const names: Record<string, string> = {}
    const count = Math.floor(random() * 5)
    for (let item = 0; item < count; item += 1) names[pickFrom(pool)] = random() < 0.1 ? '' : `name-${index}-${item}`
    const keys = Object.keys(names)
    const text: LocalizedText = { names }
    if (random() < 0.5) text.originalLanguage = keys.length > 0 && random() < 0.7 ? pickFrom(keys) : pickFrom(pool)
    texts.push(text)
  }
  const run = (clearBeforeEachCall: boolean) => texts.flatMap((text) => locales.map((uiLocale) => {
    if (clearBeforeEachCall) cache.clear()
    const title = resolveName(text, uiLocale)
    if (clearBeforeEachCall) cache.clear()
    return [title, originalNameSubtitle(text, uiLocale)]
  }))
  const cold = run(true)
  const warm = run(false)
  assert.deepEqual(warm, cold)
  assert.deepEqual(run(false), warm, '热缓存再跑一遍，结果不变')
})

test('缓存存满（上限条）后再来新标签时整体清空，之后照常补全与取名；条数从不超过上限', () => {
  cache.clear()
  const filler = Array.from({ length: cache.limit }, (_, index) => `en-x-p${index}`)
  for (const tag of filler) cache.maximize(tag)
  assert.equal(cache.size(), cache.limit)
  cache.maximize(filler[0])
  assert.equal(cache.size(), cache.limit, '命中不增加条数，也不触发清空')
  assert.deepEqual(cache.maximize('zh-TW'), uncachedMaximize('zh-TW'))
  assert.equal(cache.size(), 1, '存满后来了新标签：先整体清空，再存它')
  assert.equal(resolveName({ names: { 'zh-Hans': '京都', en: 'Kyoto' } }, 'zh-TW'), '京都')
  assert.deepEqual(cache.maximize(filler[0]), uncachedMaximize(filler[0]), '清空前的标签重新补全')
  for (let index = 0; index < cache.limit * 3; index += 1) {
    cache.maximize(`en-x-q${index}`)
    assert.ok(cache.size() <= cache.limit)
  }
})

test('缓存里的值是冻结的：调用方改不了，下一次拿到的仍是原来的结果', () => {
  cache.clear()
  const value = cache.maximize('zh-TW')
  assert.ok(value !== undefined && Object.isFrozen(value))
  assert.throws(() => {
    (value as { language: string }).language = 'ja'
  }, TypeError)
  assert.deepEqual(cache.maximize('zh-TW'), uncachedMaximize('zh-TW'))
  assert.equal(resolveName({ names: { 'zh-Hans': '京都', 'zh-Hant': '京都（繁）' } }, 'zh-TW'), '京都（繁）')
})
