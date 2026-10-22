/**
 * What each editor's draft concerns (3C-5 D, design §2; the author's decision: a conflict is judged on the whole record,
 * and a list draft on the part of the list its editor shows). A probe reads it from the page's data; `useDraft`
 * (./drafts.ts) keeps its value when the draft starts and compares it with the data as they move on.
 *
 * Values are plain data (compared as JSON); `undefined` means the record is gone.
 */
import type { DraftProbe } from './drafts.ts'

const subset = (ids: readonly string[], keep: (id: string) => boolean) => ids.filter(keep)

/** The country list: its saved order and the hidden countries. */
export const countryListProbe: DraftProbe<{ order: readonly string[]; hidden: readonly string[] }> = (snapshot) => {
  const state = snapshot.appData.editorState.travelAtlasEditorState
  return { order: state.countryOrder, hidden: state.hiddenCountryIds }
}

/** One country's cities: their saved order and which of them are hidden. */
export const cityListProbe = (countryId: string | undefined): DraftProbe<{ order: readonly string[]; hidden: readonly string[] } | undefined> => (snapshot) => {
  if (countryId === undefined) return undefined
  const state = snapshot.appData.editorState.travelAtlasEditorState
  const { countryIdOfCity } = snapshot.appData.travelAtlas
  return { order: state.cityOrderByCountry[countryId] ?? [], hidden: subset(state.hiddenCityIds, (id) => countryIdOfCity(id) === countryId) }
}

/** One city's photos (media of the kinds the list shows): their saved order, which are hidden, and the cover. */
const mediaListProbe = (cityId: string | undefined, kinds: readonly string[], orderOf: 'mediaOrderByCity' | 'droneOrderByCity', hiddenOf: 'hiddenMediaIds' | 'hiddenDroneMediaIds') =>
  (snapshot: Parameters<DraftProbe<unknown>>[0]) => {
    if (cityId === undefined) return undefined
    const state = snapshot.appData.editorState.travelAtlasEditorState
    const ofCity = new Set(snapshot.appData.mediaCatalog.allImportedMediaItems.filter((item) => item.cityId === cityId && kinds.includes(item.kind)).map((item) => item.id))
    return {
      order: state[orderOf][cityId] ?? [],
      hidden: subset(state[hiddenOf], (id) => ofCity.has(id)),
      ...(orderOf === 'mediaOrderByCity' ? { cover: state.coverMediaByCity[cityId] ?? null } : {}),
    }
  }
export const photoListProbe = (cityId: string | undefined) => mediaListProbe(cityId, ['photo'], 'mediaOrderByCity', 'hiddenMediaIds')
export const droneListProbe = (cityId: string | undefined) => mediaListProbe(cityId, ['panorama360', 'aerialPhoto'], 'droneOrderByCity', 'hiddenDroneMediaIds')

/** A want-to-go item: the fields a page shows and edits (its note, whether hidden), or undefined when it is gone. */
export const wishProbe = (id: string | undefined): DraftProbe<{ note: string | null; hidden: boolean } | undefined> => (snapshot) => {
  const item = id === undefined ? undefined : snapshot.appData.wantToGo.wantToGoItemById.get(id)
  return item ? { note: item.note ?? null, hidden: item.hidden === true } : undefined
}

/** A planned record (the conversion of a planned visit): its dates, trip and place, or undefined when it is gone. */
export const plannedProbe = (id: string | undefined): DraftProbe<Record<string, unknown> | undefined> => (snapshot) => {
  const record = id === undefined ? undefined : snapshot.appData.wantToGo.plannedRecordById.get(id)
  return record ? { start_date: record.start_date ?? null, end_date: record.end_date ?? null, trip_title: record.trip_title ?? null, city: record.city ?? null } : undefined
}
