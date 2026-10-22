import { useAppSection } from './appStore.ts'

// 足迹的派生在 ./canonical/derive.ts，数据经 ./appStore.ts 的快照（读模型 → 官方视图 → 派生）。
// 3C-5 D: the data are no module constants any more: components read them through the hook below (./appStore.ts), so a
// save moves them on without a reload and react-hooks/exhaustive-deps sees every dependency on them. Names and types are those of the module constants before D.

/**
 * 足迹的全部派生：travelAtlasDataSource、travelAtlasDisplay、plannedRecords、travelAtlasCountryCodes（FR-TA-5：供
 * plannedRecords 适配器）、travelAtlasMeta、hiddenHomeRecords、countries、cities、journeyDays、routes、countryById、cityById、
 * getCitiesForCountry、shouldHideCityFromNavigation、missingCoordinateCities，以及 countryIdOfCity（RFC-LOC-1 PR3b-1 §2.5：
 * 城市 → 所属国家，含被 editor 隐藏的城市；UI 不得再从 id 的结构推断国家）。
 */
export const useTravelAtlas = () => useAppSection('travelAtlas')
