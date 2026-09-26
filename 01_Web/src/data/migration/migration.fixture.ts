/**
 * 迁移规划（RFC-LOC-1 PR3a）测试共用的手写数据与调用方式。不是测试文件，App 代码从不 import 它。
 *
 * 全部是中性构造数据：公开样例里的冰岛 / 法罗群岛，加上几个公开地名。坐标取自公开地理事实，
 * 只为让「相距多少千米」落在需要的区间里。
 */

import type { RawAppInputs } from '../derive/appData.ts'
import { rawInputs, record } from '../canonical/legacy.fixture.ts'
import { sequentialUuids } from '../canonical/v2.fixture.ts'
import type { TravelMapDisplay } from '../derive/travelAtlas.ts'
import type { TravelMapRecord } from '../../types/travel.ts'
import type { IdentityDecisions, IdentityManifest } from './identityFiles.ts'
import { fileMetaFromRaw, planMigration, type MigrationPlan } from './planMigration.ts'

export const PLAN_NOW = '2026-09-26T00:00:00.000Z'
export const SOURCE_HASH = 'test-source-hash'

export interface PlanOptions {
  manifest?: IdentityManifest
  decisions?: IdentityDecisions
  newId?: () => string
  sourceHash?: string
}

/** 按 CLI 的方式调用 planMigration：文件级元数据取自原始数据，确定的 UUID 序列与时间。 */
export const plan = (raw: RawAppInputs, options: PlanOptions = {}): MigrationPlan => planMigration({
  raw,
  fileMeta: fileMetaFromRaw(raw),
  ...(options.manifest ? { manifest: options.manifest } : {}),
  ...(options.decisions ? { decisions: options.decisions } : {}),
  sourceHash: options.sourceHash ?? SOURCE_HASH,
  newId: options.newId ?? sequentialUuids(),
  now: PLAN_NOW,
})

/** 决定文件（只写给了的表）。 */
export const decisions = (tables: Omit<IdentityDecisions, 'schema_version'>): IdentityDecisions => ({ schema_version: 1, ...tables })

export interface WantToGoPlaceInput {
  kind?: 'city' | 'country'
  nameZh: string
  nameEn: string
  countryCode: string
  lat?: number
  lng?: number
}

/** 一条想去条目（原始格式）。 */
export const wantToGoItem = (id: string, place: WantToGoPlaceInput, extra: Record<string, unknown> = {}) => ({
  id,
  place: { kind: 'city', ...place },
  addedAt: '2026-08-12',
  hidden: false,
  ...extra,
})

export const wantToGoFile = (items: unknown[]) => ({
  schema_version: 1,
  generated_at: '2026-08-12T00:00:00.000Z',
  privacy_level: 'local-only',
  items,
})

// ---- 冰岛的几个城市（记录） ----

export const REYKJAVIK = { lat: 64.1466, lng: -21.9426 }
export const VIK = { lat: 63.4186, lng: -19.006 }
export const HUSAVIK = { lat: 66.0449, lng: -17.3389 }
export const HAFNARFJORDUR = { lat: 64.0671, lng: -21.9377 }

export const reykjavikRecord = (overrides: Partial<TravelMapRecord> = {}) =>
  record({ id: 'r_reykjavik', start_date: '2025-06-01', ...REYKJAVIK, ...overrides })

export const vikRecord = (overrides: Partial<TravelMapRecord> = {}) =>
  record({ id: 'r_vik', city: '维克', city_en: 'Vik', start_date: '2025-06-02', ...VIK, ...overrides })

export const husavikRecord = (overrides: Partial<TravelMapRecord> = {}) =>
  record({ id: 'r_husavik', city: '胡萨维克', city_en: 'Husavik', start_date: '2025-06-03', ...HUSAVIK, ...overrides })

export const akureyriRecordWithoutCoordinates = (overrides: Partial<TravelMapRecord> = {}) =>
  record({ id: 'r_akureyri', city: '阿克雷里', city_en: 'Akureyri', start_date: '2025-06-04', lat: null, lng: null, ...overrides })

export const hafnarfjordurRecord = (overrides: Partial<TravelMapRecord> = {}) =>
  record({ id: 'r_hafnarfjordur', city: '哈夫纳峡湾', city_en: 'Hafnarfjordur', start_date: '2025-06-05', ...HAFNARFJORDUR, ...overrides })

/** 个人模式原始数据：给了想去条目就写成想去文件。 */
export const personalRaw = (input: {
  records: TravelMapRecord[]
  wantToGo?: unknown[]
  display?: TravelMapDisplay
  editorState?: unknown
  mediaCatalog?: unknown
}): RawAppInputs => rawInputs({
  records: input.records,
  ...(input.display ? { display: input.display } : {}),
  ...(input.editorState !== undefined ? { editorState: input.editorState } : {}),
  ...(input.mediaCatalog !== undefined ? { mediaCatalog: input.mediaCatalog } : {}),
  ...(input.wantToGo ? { wantToGo: wantToGoFile(input.wantToGo) } : {}),
})

/**
 * 自动合并的三种情况（每个想去城市与一个足迹城市合并键相同）：
 * - 雷克雅未克：名称相同、相距约 50 m → 静默；
 * - 维克：中文名不同 → 需确认 nameDifference；
 * - 胡萨维克：相距约 5 km → 需确认 coordinateDifference；
 * - 阿克雷里：足迹城市没有坐标、想去有 → 需确认 coordinateDifference。
 */
export const autoMergeRaw = () => personalRaw({
  records: [reykjavikRecord(), vikRecord(), husavikRecord(), akureyriRecordWithoutCoordinates()],
  wantToGo: [
    wantToGoItem('w_reykjavik', { nameZh: '雷克雅未克', nameEn: 'Reykjavik', countryCode: 'IS', lat: 64.147, lng: -21.943 }),
    wantToGoItem('w_vik', { nameZh: '维克镇', nameEn: 'Vik', countryCode: 'IS', ...VIK }),
    wantToGoItem('w_husavik', { nameZh: '胡萨维克', nameEn: 'Husavik', countryCode: 'IS', lat: 66.09, lng: -17.3389 }),
    wantToGoItem('w_akureyri', { nameZh: '阿克雷里', nameEn: 'Akureyri', countryCode: 'IS', lat: 65.6885, lng: -18.1262 }),
  ],
})

/**
 * 疑似重复（同在冰岛、合并键不同）：
 * - 「雷克雅未克市」：中文名与雷克雅未克相同、坐标相同；距哈夫纳峡湾约 9 km → 与两个足迹城市都疑似重复；
 * - 「加尔扎拜尔」：距雷克雅未克约 6.5 km、距哈夫纳峡湾约 2.4 km → 也与两个都疑似重复；
 * - 努克（格陵兰）：没有足迹城市，不参与。
 */
export const duplicateRaw = () => personalRaw({
  records: [reykjavikRecord(), hafnarfjordurRecord()],
  wantToGo: [
    wantToGoItem('w_reykjavik_city', { nameZh: '雷克雅未克', nameEn: 'Reykjavik City', countryCode: 'IS', ...REYKJAVIK }),
    wantToGoItem('w_gardabaer', { nameZh: '加尔扎拜尔', nameEn: 'Gardabaer', countryCode: 'IS', lat: 64.0886, lng: -21.9227 }),
    wantToGoItem('w_nuuk', { nameZh: '努克', nameEn: 'Nuuk', countryCode: 'GL', lat: 64.1814, lng: -51.6941 }),
  ],
})
