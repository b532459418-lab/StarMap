import { appData } from './appData'
import type { City, JourneyDay, Route, TravelMapRecord } from '../types/travel'

// 数据来源的选择在 ./rawInputs.ts，派生（Legacy Adapter → Canonical → 派生）在 ./appData.ts
// （RFC-LOC-1 PR2）；本文件以原名导出。
const derived = appData.travelAtlas

// 声明成 string：与 PR1 之前的导出类型（`localTravelMap ? 'local' : 'sample'` 推断出的 string）保持一致。
export const travelAtlasDataSource: string = derived.travelAtlasDataSource

export const travelAtlasDisplay = derived.travelAtlasDisplay

// FR-TA-5：planned 记录与国家代码表供调用方传给 Core 的 plannedRecords 适配器，
// 说明见 ./derive/travelAtlas.ts 里 plannedRecords 的注释。
export const plannedRecords: TravelMapRecord[] = derived.plannedRecords
export const travelAtlasCountryCodes: Record<string, string> = derived.travelAtlasCountryCodes

export const travelAtlasMeta = derived.travelAtlasMeta

export const hiddenHomeRecords = derived.hiddenHomeRecords

export const countries = derived.countries

export const cities: City[] = derived.cities

export const journeyDays: JourneyDay[] = derived.journeyDays

export const routes: Route[] = derived.routes

export const countryById = derived.countryById

export const cityById = derived.cityById

export const getCitiesForCountry = derived.getCitiesForCountry

export const shouldHideCityFromNavigation = derived.shouldHideCityFromNavigation

export const missingCoordinateCities = derived.missingCoordinateCities
