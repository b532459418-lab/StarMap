import travelMapSample from './travel-map.sample.json'
import { privateTravelMap } from 'virtual:starmap-private-data'
import { travelAtlasEditorState } from './editorState'
import { deriveTravelAtlas, isTravelMapExport, type TravelMapExport } from './derive/travelAtlas.ts'
import type { City, JourneyDay, Route, TravelMapRecord } from '../types/travel'

// 派生逻辑（国家别名归一、分类、行程分组、国家 / 城市 / 行程日 / 路线）在纯派生层
// ./derive/travelAtlas.ts（RFC-LOC-1 PR1）；本文件只负责选出数据来源并以原名导出。

const forceSampleData = import.meta.env.VITE_TRAVEL_ATLAS_DATA_MODE === 'sample'
  || (import.meta.env.DEV
    && typeof window !== 'undefined'
    && new URLSearchParams(window.location.search).get('data') === 'sample')
const localTravelMap = forceSampleData
  ? undefined
  : isTravelMapExport(privateTravelMap) ? privateTravelMap : undefined
const exportData = localTravelMap ?? (travelMapSample as TravelMapExport)

export const travelAtlasDataSource = localTravelMap ? 'local' : 'sample'

const derived = deriveTravelAtlas(exportData, travelAtlasEditorState)

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
