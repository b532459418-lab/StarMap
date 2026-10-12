/**
 * 大洲（审查 C5）：国家 / 地区的 ISO 3166-1 alpha-2 代码 → 大洲，查不到时才按国家关键词与记录上的地区名推断。
 *
 * 国家目录（world-countries）把美洲国家的 region 一律写成 `Americas`，南极地区写成 `Antarctic`，原来只按地区名推断，
 * 美洲 56 国与南极 5 个地区都显示「—」。下面的表由一次性脚本从 world-countries 5.1.0（250 项）生成，脚本不提交：
 * - region 为 `Americas` 的按 subregion 区分：North America、Central America、Caribbean → North America，South America → South America；
 * - `Antarctic` → Antarctica；
 * - 其余 region（Europe、Asia、Africa、Oceania）原样。
 * 客户端只带这张表，不引入整个 world-countries。`./continents.test.ts` 用 world-countries 核对每一项。
 *
 * 约束：Node 24 能直接加载——erasable-only TypeScript，相对 import 带 `.ts`，类型用 `import type`。
 */

import type { Country } from '../types/travel.ts'

/** 全部大洲。界面文案的键是 `details:continent<去掉空格的名字>`（i18n:check 按这个列表核对）。 */
export const CONTINENTS = ['Africa', 'Antarctica', 'Asia', 'Europe', 'North America', 'Oceania', 'South America'] as const

export type Continent = (typeof CONTINENTS)[number]

/** 每个大洲的两位代码（大写，空格分隔，按字母排序）。 */
const CODES_BY_CONTINENT: Readonly<Record<Continent, string>> = {
  Africa: [
    'AO BF BI BJ BW CD CF CG CI CM CV DJ DZ EG EH ER ET GA GH GM GN GQ GW IO',
    'KE KM LR LS LY MA MG ML MR MU MW MZ NA NE NG RE RW SC SD SH SL SN SO SS',
    'ST SZ TD TG TN TZ UG YT ZA ZM ZW',
  ].join(' '),
  Antarctica: [
    'AQ BV GS HM TF',
  ].join(' '),
  Asia: [
    'AE AF AM AZ BD BH BN BT CN GE HK ID IL IN IQ IR JO JP KG KH KP KR KW KZ',
    'LA LB LK MM MN MO MV MY NP OM PH PK PS QA SA SG SY TH TJ TL TM TR TW UZ',
    'VN YE',
  ].join(' '),
  Europe: [
    'AD AL AT AX BA BE BG BY CH CY CZ DE DK EE ES FI FO FR GB GG GI GR HR HU',
    'IE IM IS IT JE LI LT LU LV MC MD ME MK MT NL NO PL PT RO RS RU SE SI SJ',
    'SK SM UA VA XK',
  ].join(' '),
  'North America': [
    'AG AI AW BB BL BM BQ BS BZ CA CR CU CW DM DO GD GL GP GT HN HT JM KN KY',
    'LC MF MQ MS MX NI PA PM PR SV SX TC TT UM US VC VG VI',
  ].join(' '),
  Oceania: [
    'AS AU CC CK CX FJ FM GU KI MH MP NC NF NR NU NZ PF PG PN PW SB TK TO TV',
    'VU WF WS',
  ].join(' '),
  'South America': [
    'AR BO BR CL CO EC FK GF GY PE PY SR UY VE',
  ].join(' '),
}

const continentByCode: ReadonlyMap<string, Continent> = new Map(
  (Object.entries(CODES_BY_CONTINENT) as [Continent, string][])
    .flatMap(([continent, codes]) => codes.split(' ').map((code): [string, Continent] => [code, continent])),
)

/** 两位代码（大小写不限）→ 大洲；不认识的代码为 undefined。 */
export const continentOfCountryCode = (code: string | undefined): Continent | undefined =>
  code ? continentByCode.get(code.trim().toUpperCase()) : undefined

/** 按国家关键词与记录上的地区名推断（原来的规则，只作代码查不到时的回退）。 */
const continentRules: Array<{ continent: Continent; regions: string[] }> = [
  { continent: 'North America', regions: ['north america', '北美', '中美', '加勒比'] },
  { continent: 'South America', regions: ['south america', '南美'] },
  { continent: 'Europe', regions: ['europe', '欧洲', '北欧', '东欧', '西欧', '南欧', '欧亚'] },
  { continent: 'Asia', regions: ['asia', '亚洲', '东亚', '东南亚', '南亚', '中亚', '西亚', '中东', '印度洋'] },
  { continent: 'Africa', regions: ['africa', '非洲', '北非', '东非', '西非', '南非'] },
  { continent: 'Oceania', regions: ['oceania', '大洋洲', '澳洲'] },
  { continent: 'Antarctica', regions: ['antarctica', '南极'] },
]

const continentFromRegionText = (country: Pick<Country, 'keywords' | 'records'>): Continent | undefined => {
  const regionText = [
    ...(country.keywords ?? []),
    ...(country.records?.map((record) => record.region).filter(Boolean) ?? []),
  ]
    .join(' ')
    .toLowerCase()
  return continentRules.find(({ regions }) => regions.some((region) => regionText.includes(region)))?.continent
}

/** 国家的大洲：先按国家代码（国旗代码就是小写的 ISO 代码）查表，查不到才按关键词推断；都没有时为 undefined。 */
export const continentOfCountry = (country: Pick<Country, 'flagCode' | 'keywords' | 'records'> | undefined): Continent | undefined =>
  country === undefined ? undefined : continentOfCountryCode(country.flagCode) ?? continentFromRegionText(country)
