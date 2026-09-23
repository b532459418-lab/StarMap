/**
 * 样例数据 fixture —— travelAtlas.ts 对 tracked 的 src/data/travel-map.sample.json 的已知输出。
 *
 * 为什么手写而不是 import travelAtlas.ts：travelAtlas.ts import 了 Vite 虚拟模块
 * 'virtual:starmap-private-data' 并读 import.meta.env，两者在 Vite 之外都无法解析，
 * node --test 直接崩；FR-MOD 也禁止 Core 依赖它。
 *
 * 手写 fixture 的风险是会跟真实数据漂移，因此 travel.test.ts 里有一个专门的测试
 * （"fixture 与 tracked 的 travel-map.sample.json 保持一致"）把它逐字段钉回那份 JSON。
 * 本文件由 travel.test.ts 抽出（PR3），供 travel.test.ts 与 query.parity.test.ts 共用；
 * 内容与抽出前逐字相同，改它等于同时改动那两处测试的前提。
 *
 * 本文件不是测试文件（npm test 的 glob 只匹配 .test.ts），也不会进生产构建——
 * 没有任何应用代码 import 它。
 *
 * 语法约束同 Core 其余文件：erasable-only TypeScript。
 */

import type { City, Country, JourneyDay, Route } from '../../types/travel.ts'

export const sampleCountries = (): Country[] => [
  {
    id: 'iceland',
    nameZh: '冰岛',
    nameEn: 'Iceland',
    centerLat: 64.4179,
    // 注意：这是 (-21.9426 + -19.006 + -18.1262) / 3 的 IEEE-754 结果，
    // 不是 -19.6916。写成 -19.6916 断言必挂。
    centerLng: -19.691599999999998,
    visitedDateRange: '2025-06-01 - 2025-06-05',
    summary: '3 visited cities collected from Archive export.',
    memory: '2025 North Atlantic Demo',
    keywords: ['North Atlantic'],
    cityIds: ['iceland__reykjavik', 'iceland__vik', 'iceland__akureyri'],
    accent: '#66c7a8',
    flag: '🇮🇸',
    flagCode: 'is',
    missingCoordinates: false,
  },
  {
    id: 'faroe-islands',
    nameZh: '法罗群岛',
    nameEn: 'Faroe Islands',
    centerLat: 62.16645,
    centerLng: -6.865,
    visitedDateRange: '2025-06-06 - 2025-06-08',
    summary: '2 visited cities collected from Archive export.',
    memory: '2025 North Atlantic Demo',
    keywords: ['North Atlantic'],
    cityIds: ['faroe-islands__torshavn', 'faroe-islands__gjogv'],
    accent: '#f28b82',
    flag: '🇫🇴',
    flagCode: 'fo',
    missingCoordinates: false,
  },
]

export const sampleCities = (): City[] => [
  {
    id: 'iceland__reykjavik',
    nameZh: '雷克雅未克',
    nameEn: 'Reykjavik',
    countryId: 'iceland',
    lat: 64.1466,
    lng: -21.9426,
    visitedDateRange: '2025-06-01 - 2025-06-02',
    summary: '2025 North Atlantic Demo',
    memory: 'Sample city record.',
    keywords: ['North Atlantic'],
    missingCoordinates: false,
  },
  {
    id: 'iceland__vik',
    nameZh: '维克',
    nameEn: 'Vik',
    countryId: 'iceland',
    lat: 63.4186,
    lng: -19.006,
    visitedDateRange: '2025-06-03',
    summary: '2025 North Atlantic Demo',
    memory: 'Sample landscape stop.',
    keywords: ['North Atlantic'],
    missingCoordinates: false,
  },
  {
    id: 'iceland__akureyri',
    nameZh: '阿克雷里',
    nameEn: 'Akureyri',
    countryId: 'iceland',
    lat: 65.6885,
    lng: -18.1262,
    visitedDateRange: '2025-06-04 - 2025-06-05',
    summary: '2025 North Atlantic Demo',
    memory: 'Sample northern city record.',
    keywords: ['North Atlantic'],
    missingCoordinates: false,
  },
  {
    id: 'faroe-islands__torshavn',
    nameZh: '托尔斯港',
    nameEn: 'Torshavn',
    countryId: 'faroe-islands',
    lat: 62.0079,
    lng: -6.79,
    visitedDateRange: '2025-06-06 - 2025-06-07',
    summary: '2025 North Atlantic Demo',
    memory: 'Sample island capital record.',
    keywords: ['North Atlantic'],
    missingCoordinates: false,
  },
  {
    id: 'faroe-islands__gjogv',
    nameZh: '杰格夫',
    nameEn: 'Gjogv',
    countryId: 'faroe-islands',
    lat: 62.325,
    lng: -6.94,
    visitedDateRange: '2025-06-08',
    summary: '2025 North Atlantic Demo',
    memory: 'Sample coastal village record.',
    keywords: ['North Atlantic'],
    missingCoordinates: false,
  },
]

export const JOURNEY_ID = '2025-north-atlantic-demo'
export const TRIP_TITLE = '2025 North Atlantic Demo'

export const sampleJourneyDays = (): JourneyDay[] => [
  {
    id: 'sample_reykjavik',
    date: '2025-06-01',
    countryId: 'iceland',
    cityId: 'iceland__reykjavik',
    title: TRIP_TITLE,
    summary: 'Reykjavik, 2025-06-01 - 2025-06-02',
    journeyId: JOURNEY_ID,
    isHighlight: true,
  },
  {
    id: 'sample_vik',
    date: '2025-06-03',
    countryId: 'iceland',
    cityId: 'iceland__vik',
    title: TRIP_TITLE,
    summary: 'Vik, 2025-06-03',
    journeyId: JOURNEY_ID,
    isHighlight: true,
  },
  {
    id: 'sample_akureyri',
    date: '2025-06-04',
    countryId: 'iceland',
    cityId: 'iceland__akureyri',
    title: TRIP_TITLE,
    summary: 'Akureyri, 2025-06-04 - 2025-06-05',
    journeyId: JOURNEY_ID,
    isHighlight: true,
  },
  {
    id: 'sample_torshavn',
    date: '2025-06-06',
    countryId: 'faroe-islands',
    cityId: 'faroe-islands__torshavn',
    title: TRIP_TITLE,
    summary: 'Torshavn, 2025-06-06 - 2025-06-07',
    journeyId: JOURNEY_ID,
    isHighlight: true,
  },
  {
    id: 'sample_gjogv',
    date: '2025-06-08',
    countryId: 'faroe-islands',
    cityId: 'faroe-islands__gjogv',
    title: TRIP_TITLE,
    summary: 'Gjogv, 2025-06-08',
    journeyId: JOURNEY_ID,
    isHighlight: true,
  },
]

export const sampleRoutes = (): Route[] => [
  {
    id: `${JOURNEY_ID}__sample_reykjavik__sample_vik`,
    fromCityId: 'iceland__reykjavik',
    toCityId: 'iceland__vik',
    journeyId: JOURNEY_ID,
    type: 'main',
  },
  {
    id: `${JOURNEY_ID}__sample_vik__sample_akureyri`,
    fromCityId: 'iceland__vik',
    toCityId: 'iceland__akureyri',
    journeyId: JOURNEY_ID,
    type: 'main',
  },
  {
    id: `${JOURNEY_ID}__sample_akureyri__sample_torshavn`,
    fromCityId: 'iceland__akureyri',
    toCityId: 'faroe-islands__torshavn',
    journeyId: JOURNEY_ID,
    type: 'flight',
  },
  {
    id: `${JOURNEY_ID}__sample_torshavn__sample_gjogv`,
    fromCityId: 'faroe-islands__torshavn',
    toCityId: 'faroe-islands__gjogv',
    journeyId: JOURNEY_ID,
    type: 'main',
  },
]

export const sampleInput = () => ({
  countries: sampleCountries(),
  cities: sampleCities(),
  journeyDays: sampleJourneyDays(),
  routes: sampleRoutes(),
})
