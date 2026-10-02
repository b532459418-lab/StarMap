/**
 * 多语言名称 —— `LocalizedText` 与它的取名规则（RFC-LOC-1 LOC-1 / LOC-3 / LOC-5，Core 方案 C7）。
 *
 * 【待《World Graph Core Model RFC》定稿】
 *
 * 1. `LocalizedText` 只存「各语言下的名称」与可选的原名语言，不存回退结果：显示哪个名称由 `resolveName`
 *    按界面语言现算（LOC-3：回退规则是公共函数，不存进数据）。
 * 2. 放在 Core：Collection 的搜索与排序也要用（RFC LOC-3）。只用 ECMAScript 内建的 `Intl`，不引 i18n 库。
 * 3. 纯函数：不修改输入、不读时钟、不读环境（不取运行环境的默认 locale）。界面语言由调用方传入。
 *
 * 语法约束：erasable-only TypeScript（只用 type / interface）。
 */

/** BCP 47 语言标签，如 'en'、'ja'、'ko'、'zh-Hans'、'zh-Hant'；判断不了用 'und'（RFC LOC-1 / LOC-2）。 */
export type LanguageTag = string

/** RFC LOC-1。 */
export interface LocalizedText {
  /** 各语言下的名称；键为 BCP 47 标签。值为空字符串的键视为不存在。 */
  names: Record<LanguageTag, string>
  /** 原名的语言；原名就是 `names[originalLanguage]`。没有可靠来源时不填，不猜。 */
  originalLanguage?: LanguageTag
}

/** 补全后的标签（第 0 步）。 */
interface MaximizedTag {
  tag: LanguageTag
  language: string
  script: string | undefined
  region: string | undefined
}

/** 按 Unicode 码点比较（不是 UTF-16 码元，也不受运行环境 locale 影响）：给标签排序，保证结果稳定。 */
const compareCodePoints = (left: string, right: string): number => {
  const a = Array.from(left, (char) => char.codePointAt(0) ?? 0)
  const b = Array.from(right, (char) => char.codePointAt(0) ?? 0)
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index]
  }
  return a.length - b.length
}

/**
 * 第 0 步：`Intl.Locale#maximize()` 补全书写系统与地区（zh-CN → zh-Hans-CN，zh-TW → zh-Hant-TW，ja → ja-Jpan-JP）。
 * 解析失败、或语言是 `und` 时返回 undefined：这样的键只参加第 5 步（`und` 补全后会变成 en-Latn-US，不能拿来匹配）。
 */
const maximizeTag = (tag: LanguageTag): MaximizedTag | undefined => {
  let locale: Intl.Locale
  try {
    locale = new Intl.Locale(tag)
  } catch {
    return undefined
  }
  // 有的引擎对 `und` 返回 language === undefined（V8 即如此），两种都算 und。
  if (!locale.language || locale.language === 'und') return undefined
  const maximized = locale.maximize()
  return { tag, language: maximized.language, script: maximized.script, region: maximized.region }
}

/** 非空的名称，按标签码点序。 */
const presentEntries = (text: LocalizedText): [LanguageTag, string][] =>
  Object.entries(text.names)
    .filter(([, value]) => typeof value === 'string' && value !== '')
    .sort(([left], [right]) => compareCodePoints(left, right))

/** 原名：`names[originalLanguage]`，非空且这个键能参加第 0–4 步时才算有。 */
const originalNameOf = (text: LocalizedText, present: readonly [LanguageTag, string][]): string | undefined => {
  const language = text.originalLanguage
  if (language === undefined || maximizeTag(language) === undefined) return undefined
  return present.find(([tag]) => tag === language)?.[1]
}

/** 「英文」：语言为 `en` 的键，优先正好是 `en` 的，其次按码点序（`present` 已按码点序）。 */
const englishNameOf = (present: readonly [LanguageTag, string][], parsed: readonly MaximizedTag[]): string | undefined => {
  const exact = present.find(([tag]) => tag === 'en')
  if (exact) return exact[1]
  const tag = parsed.find((candidate) => candidate.language === 'en')?.tag
  return tag === undefined ? undefined : present.find(([key]) => key === tag)?.[1]
}

/** 第 4 步「原名优先」的界面语言（RFC LOC-3：中日韩界面）。 */
const ORIGINAL_FIRST_LANGUAGES = new Set(['zh', 'ja', 'ko'])

/** 第 3 步：中文简繁互退只在这两种书写系统之间。 */
const CHINESE_SCRIPTS = new Set(['Hans', 'Hant'])

/**
 * 按界面语言取显示名称（RFC LOC-3 的五步）：
 *
 * 0. 两边都用 `Intl.Locale#maximize()` 补全；解析失败的键与 `und` 只参加第 5 步。
 * 1. 精确匹配：补全后的语言、书写系统、地区都相同。
 * 2. 去掉地区、保留书写系统：语言与书写系统相同；多个候选时取补全后地区与界面相同的，否则按标签码点序取第一个。
 * 3. 中文简繁互退：界面语言是 `zh` 时，取另一种书写系统（Hans ↔ Hant）的中文名。
 * 4. 产品回退：中日韩界面先原名、再英文；其他界面先英文、再原名。
 * 5. 兜底：任一非空名称，按标签码点序取第一个。
 *
 * 第 1、3 步有多个候选时同样按标签码点序取第一个。没有任何非空名称时返回 `''`；界面语言无法解析时直接从第 4 步
 * （按「其他界面」）开始。
 */
export const resolveName = (text: LocalizedText, uiLocale: LanguageTag): string => {
  const present = presentEntries(text)
  if (present.length === 0) return ''
  const valueOf = (tag: LanguageTag): string => present.find(([key]) => key === tag)?.[1] ?? ''
  const parsed = present.map(([tag]) => maximizeTag(tag)).filter((tag): tag is MaximizedTag => tag !== undefined)
  const ui = maximizeTag(uiLocale)

  if (ui) {
    const sameScript = parsed.filter((tag) => tag.language === ui.language && tag.script === ui.script)
    const exact = sameScript.find((tag) => tag.region === ui.region)
    if (exact) return valueOf(exact.tag)
    if (sameScript.length > 0) return valueOf(sameScript[0].tag)
    if (ui.language === 'zh') {
      const otherScript = parsed.find((tag) => (
        tag.language === 'zh' && tag.script !== undefined && CHINESE_SCRIPTS.has(tag.script) && tag.script !== ui.script
      ))
      if (otherScript) return valueOf(otherScript.tag)
    }
  }

  const original = originalNameOf(text, present)
  const english = englishNameOf(present, parsed)
  const fallback = ui && ORIGINAL_FIRST_LANGUAGES.has(ui.language) ? original ?? english : english ?? original
  return fallback ?? present[0][1]
}

/**
 * 原名副标题（RFC LOC-5）：原名存在，且与 `resolveName` 的结果不同时返回原名；否则 undefined。
 * 从旧数据迁移来的地点没有 `originalLanguage`，因此没有副标题。
 */
export const originalNameSubtitle = (text: LocalizedText, uiLocale: LanguageTag): string | undefined => {
  const original = originalNameOf(text, presentEntries(text))
  return original !== undefined && original !== resolveName(text, uiLocale) ? original : undefined
}

/** 搜索用的全部名称：`names` 的全部非空值，按标签码点序（RFC LOC-3：搜索匹配全部值，不只是当前显示的那个）。 */
export const searchableNames = (text: LocalizedText): string[] => presentEntries(text).map(([, value]) => value)

/** 复制一份：新的 `names` 对象，`originalLanguage` 有才写；不与输入共享引用。 */
export const copyLocalizedText = (text: LocalizedText): LocalizedText => {
  const copy: LocalizedText = { names: { ...text.names } }
  if (text.originalLanguage !== undefined) copy.originalLanguage = text.originalLanguage
  return copy
}
