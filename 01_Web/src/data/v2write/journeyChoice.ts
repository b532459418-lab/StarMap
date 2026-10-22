/**
 * 同名行程的选择在 V2 文件上的用法（第 2C 批）。判定在 ../editor/rules/journeys.ts（3C-5 C2 迁出，存储原生的写入共用）；
 * 这里给出五个 V2 文件里的记录与地点名，并把「新建」写成 `journey-<UUIDv7>`。
 *
 * `src/data/v2write/` 是 App 层，【不是】 StarMap Core。
 * 约束：Node 24 能直接加载——erasable-only TypeScript，相对 import 带 `.ts`，类型用 `import type`。
 */

import type { V2Files } from '../canonical/v2Schema.ts'
import { decideJourney, findJourneyCandidates as candidatesOf, type JourneyCandidate, type JourneyChoice } from '../editor/rules/journeys.ts'
import type { V2WriteContext } from './transaction.ts'

export {
  JOURNEY_CANDIDATE_CITY_LIMIT, journeyChoiceOf, type JourneyCandidate, type JourneyCandidateCity, type JourneyChoice,
} from '../editor/rules/journeys.ts'

/** 同标题的已有行程（../editor/rules/journeys.ts 的 findJourneyCandidates），在五个 V2 文件的全部记录上。 */
export const findJourneyCandidates = (files: V2Files, tripTitle: string | undefined): JourneyCandidate[] => {
  const placeById = new Map(files.places.places.map((place) => [place.id, place]))
  return candidatesOf(files.travel.records, tripTitle, (placeId) => placeById.get(placeId)?.names)
}

const newJourneyId = (ctx: V2WriteContext) => `journey-${ctx.newId()}`

/**
 * 新变成「已去过」的记录的 `journeyId`：加入选定的同标题行程，或新建 `journey-<UUIDv7>`；有候选而没有选择时
 * `E_JOURNEY_CHOICE_REQUIRED`（../editor/rules/journeys.ts 的 decideJourney）。
 */
export const journeyIdFor = (files: V2Files, tripTitle: string | undefined, ctx: V2WriteContext, choice: JourneyChoice): string => {
  const decided = decideJourney(choice, () => findJourneyCandidates(files, tripTitle), tripTitle)
  return 'join' in decided ? decided.join : newJourneyId(ctx)
}
