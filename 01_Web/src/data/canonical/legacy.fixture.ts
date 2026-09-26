/**
 * PR2（Canonical Model 与 Legacy Adapter）测试共用的手写数据与三条路径。
 *
 * 不是测试文件，App 代码从不 import 它。全部是中性构造数据：公开样例 + 故意写得不一致的几条记录。
 *
 * 三条路径（PR2 规格 §2.1）都经 `buildBaseline` + `stableStringify` 变成可逐字节比较的字符串：
 *   A = PR1 的 deriveAppData(原始数据)                          `pathA`（本文件）
 *   B = PR1 的 deriveAppData(normalizeLegacy(原始数据))         见 normalizeLegacy.test.ts / derive.test.ts
 *   C = deriveAppDataFromCanonical(legacyAdapter(原始数据))     见 derive.test.ts
 *
 * 下面这行 reference 不能删，理由见 src/worldgraph/adapters/travel.test.ts 文件头。
 */

/// <reference types="node" />

import { readFileSync } from 'node:fs'

import { deriveAppData, type RawAppInputs } from '../derive/appData.ts'
import { buildBaseline, stableStringify } from '../derive/baseline.ts'
import type { TravelMapDisplay, TravelMapExport } from '../derive/travelAtlas.ts'
import type { TravelMapRecord } from '../../types/travel.ts'

export const NOW = '2000-01-01T00:00:00.000Z'

/** PR1 公布的公开样例基线哈希（`legacy-baseline.mjs --sample`）。 */
export const SAMPLE_BASELINE_SHA256 = 'eb91f172531f7c87280b07399af6ee80d1fc6e99a2ad38efa50b60b9afd299a4'

const readSample = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), 'utf8'))

export const sampleTravelMap = () => readSample('travel-map.sample.json') as TravelMapExport

export const sampleWantToGo = () => readSample('want-to-go.sample.json') as { schema_version: number; items: unknown[] }

/** 公开模式语义：足迹样例、想去样例、editor-state 与媒体为空（同 legacy-baseline.mjs --sample）。 */
export const sampleRaw = (): RawAppInputs => ({
  travelMap: sampleTravelMap(),
  travelAtlasDataSource: 'sample',
  editorState: undefined,
  mediaCatalog: undefined,
  wantToGo: { source: 'sample', value: sampleWantToGo() },
  now: NOW,
})

/** 个人模式语义的原始输入；没给的部分为空。 */
export const rawInputs = (input: {
  records: TravelMapRecord[]
  display?: TravelMapDisplay
  editorState?: unknown
  mediaCatalog?: unknown
  wantToGo?: unknown
}): RawAppInputs => ({
  travelMap: {
    schema_version: 1,
    generated_at: '2026-01-01',
    privacy_level: 'local-only',
    ...(input.display !== undefined ? { display: input.display } : {}),
    records: input.records,
  },
  travelAtlasDataSource: 'local',
  editorState: input.editorState,
  mediaCatalog: input.mediaCatalog,
  wantToGo: input.wantToGo === undefined ? { source: 'none', value: undefined } : { source: 'local', value: input.wantToGo },
  now: NOW,
})

/** 一条中性的足迹记录；没给的字段取「冰岛 · 雷克雅未克」。 */
export const record = (overrides: Partial<TravelMapRecord> & { id: string }): TravelMapRecord => ({
  country: '冰岛',
  country_en: 'Iceland',
  country_code: 'is',
  city: '雷克雅未克',
  city_en: 'Reykjavik',
  start_date: '2025-06-01',
  year: 2025,
  trip_title: '2025 North Atlantic Demo',
  status: 'visited',
  lat: 64.1466,
  lng: -21.9426,
  ...overrides,
})

/**
 * PR1 审查记录「名称不一致测试」的七类，各一条（接在公开样例五条之后，同一趟行程）：
 * 城市中文名不同、城市英文名大小写不同且无行程标题、国家英文名大小写不同、国家繁简不同、
 * 城市英文名带变音符、国家代码不同、英文名为空且中文名不同。
 */
export const nameInconsistencyRecords = (): TravelMapRecord[] => [
  record({ id: 'mismatch_city_zh', city: '雷克雅维克', start_date: '2025-06-09' }),
  record({ id: 'mismatch_city_en_case', city_en: 'reykjavik', trip_title: undefined, start_date: '2025-06-10' }),
  record({ id: 'mismatch_country_en_case', country_en: 'iceland', city: '阿克雷里', city_en: 'Akureyri', lat: 65.6885, lng: -18.1262, start_date: '2025-06-11' }),
  record({ id: 'mismatch_country_zh', country: '冰島', city: '维克', city_en: 'Vik', lat: 63.4186, lng: -19.006, start_date: '2025-06-12' }),
  record({ id: 'mismatch_city_diacritic', country: '法罗群岛', country_en: 'Faroe Islands', country_code: 'fo', city: '托尔斯港', city_en: 'Tórshavn', lat: 62.0079, lng: -6.79, start_date: '2025-06-13' }),
  record({ id: 'mismatch_country_code', country: '法罗群岛', country_en: 'Faroe Islands', country_code: 'dk', city: '杰格夫', city_en: 'Gjogv', lat: 62.325, lng: -6.94, start_date: '2025-06-14' }),
  record({ id: 'mismatch_city_empty_en', city: '维克镇', city_en: '', lat: 63.42, lng: -19.01, start_date: '2025-06-15' }),
]

/** 公开样例 + 七条名称不一致记录（个人模式语义）。 */
export const nameInconsistencyRaw = (): RawAppInputs => {
  const sample = sampleTravelMap()
  return rawInputs({ records: [...sample.records, ...nameInconsistencyRecords()], display: sample.display })
}

/**
 * 没有名称不一致的个人模式数据（与 PR2 规格 §6 临时私人根的内容相同）：
 * 公开样例 + 用国家别名写法的一条记录（带 regionSuffix）+ 一条 planned 记录（卑尔根，NO）；
 * editor-state 隐藏一个城市、调换两个国家的顺序、设一张封面；想去样例其中一条 hidden；
 * 媒体两张城市照片、一张无人机照片，`withDanglingMedia` 时再加一张引用不存在城市的照片。
 */
export const consistentPersonalRaw = (options: { withDanglingMedia?: boolean } = {}): RawAppInputs => {
  const sample = sampleTravelMap()
  const wantToGo = sampleWantToGo()
  ;(wantToGo.items[1] as { hidden: boolean }).hidden = true
  const media = (overrides: Record<string, unknown>) => ({
    kind: 'photo',
    scope: 'city',
    countryId: 'iceland',
    countryName: 'Iceland',
    cityId: 'iceland__reykjavik',
    cityName: 'Reykjavik',
    isCover: false,
    status: 'ready',
    ...overrides,
  })
  return rawInputs({
    records: [
      ...sample.records,
      record({ id: 'alias_klaksvik', country: '法羅群島', country_en: 'Faeroe Islands', country_code: 'fo', city: '克拉克斯维克', city_en: 'Klaksvik', region: 'North Atlantic', start_date: '2025-06-09', lat: 62.2266, lng: -6.589 }),
      record({ id: 'planned_bergen', country: '挪威', country_en: 'Norway', country_code: 'no', city: '卑尔根', city_en: 'Bergen', trip_title: '2026 Fjord Plan', start_date: '2026-07-01', status: 'planned', lat: 60.3913, lng: 5.3221, notes: 'Planned fjord stop.' }),
    ],
    display: {
      ...sample.display,
      countryAliases: { 'Faeroe Islands': { country: '法罗群岛', country_en: 'Faroe Islands', regionSuffix: 'Nordoyar' } },
      countryCodes: { ...sample.display?.countryCodes, Norway: 'no' },
    },
    editorState: {
      schemaVersion: 1,
      addedCountries: [],
      countryOrder: ['faroe-islands', 'iceland'],
      hiddenCountryIds: [],
      cityOrderByCountry: {},
      hiddenCityIds: ['iceland__vik'],
      mediaOrderByCity: {},
      hiddenMediaIds: [],
      coverMediaByCity: { iceland__reykjavik: 'photo-reykjavik-2' },
      droneOrderByCity: {},
      hiddenDroneMediaIds: [],
      updatedAt: '2026-09-01T00:00:00.000Z',
    },
    mediaCatalog: {
      schemaVersion: 2,
      items: [
        media({ id: 'photo-reykjavik-1', src: '/media/user/sample/photo-1.jpg', originalFileName: 'photo-1.jpg', titleZh: '港口', titleEn: 'Harbour' }),
        media({ id: 'photo-reykjavik-2', src: '/media/user/sample/photo-2.jpg', originalFileName: 'photo-2.jpg' }),
        media({
          id: 'drone-torshavn-1', kind: 'aerialPhoto', countryId: 'faroe-islands', countryName: 'Faroe Islands', cityId: 'faroe-islands__torshavn', cityName: 'Torshavn',
          src: '/media/user/sample/drone-1.jpg', originalFileName: 'drone-1.jpg', date: '2025-06-06', resolution: '4000x3000',
          position: { lat: 62.01, lng: -6.77, altitudeMeters: 120 },
        }),
        ...(options.withDanglingMedia
          ? [media({ id: 'photo-ghost-1', countryId: 'atlantis', countryName: 'Atlantis', cityId: 'atlantis__ghost-town', cityName: 'Ghost Town', src: '/media/user/sample/ghost.jpg', originalFileName: 'ghost.jpg' })]
          : []),
      ],
    },
    wantToGo,
  })
}

/** 六个模块的导出 → 可逐字节比较的基线字符串（同 legacy-baseline.mjs，不含末尾换行）。 */
export const baselineText = (data: ReturnType<typeof deriveAppData>) => stableStringify(buildBaseline(data, { now: NOW }))

/** A：旧路径跑原始数据。 */
export const pathA = (raw: RawAppInputs) => baselineText(deriveAppData(raw))
