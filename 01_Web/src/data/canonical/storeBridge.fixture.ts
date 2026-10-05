/// <reference types="node" />
/** Only tracked neutral sample and invented data. Not imported by the App. */
import { readFileSync } from 'node:fs'
import type { V2Files } from './v2Schema.ts'
export const BRIDGE_NOW = '2026-10-05T00:00:00.000Z'
export function publicBridgeFixture(): V2Files {
  const read = (name: string) => JSON.parse(readFileSync(new URL(`../v2-sample/${name}.json`, import.meta.url), 'utf8'))
  return { places: read('places'), travel: read('travel-map'), wantToGo: read('want-to-go'), editorState: read('editor-state'), media: read('user-media') }
}
export function syntheticBridgeFixture(): V2Files {
  const files = publicBridgeFixture(), [a, b, c] = files.places.places.filter(p => p.subtype === 'city')
  const country = files.places.places.find(p => p.id === a.partOf)!
  delete b.location
  a.externalIds = { ...a.externalIds, gazetteer: 'synthetic-external' } as typeof a.externalIds
  files.travel.records = [
    { id: 'collision', placeId: a.id, start_date: '2025-01-01', lat: 0, lng: 0, status: 'visited', journeyId: 'synthetic-trip', notes: '', source: 'v2:planned' },
    { id: 'middle', placeId: b.id, start_date: '2025-01-02', lat: null, lng: null, hiddenFromHome: true, journeyId: 'synthetic-trip', notes: 'Neutral note' },
    { id: 'end', placeId: c.id, start_date: '2025-01-03', journeyId: 'synthetic-trip' },
    { id: 'collision', placeId: a.id, start_date: '2027-06', status: 'planned', notes: 'Synthetic plan' },
    { id: 'repeat', placeId: a.id, start_date: '2025', end_date: '2025-08', year: 2025, custom: { flags: [false, 0, ''], recordId: 'opaque-preserved' } } as V2Files['travel']['records'][number],
    { id: 'uncertain', placeId: c.id, start_date: '2025-02-31', end_date: '2024-01-01', year: 'unknown', notes: null, hiddenFromHome: 'unknown' } as unknown as V2Files['travel']['records'][number],
    { id: 'no-date', placeId: c.id } as V2Files['travel']['records'][number],
  ]
  files.wantToGo.items = [{ id: 'collision', placeId: a.id, note: '', addedAt: '2026-01-01', hidden: true, source: 'travel-map:planned' }]
  files.editorState.addedCountries = [{ placeId: country.id, visitedDate: '2024', region: 'Synthetic region' }, { placeId: files.places.places.find(p => p.subtype === 'country' && p.id !== country.id)!.id, visitedDate: '' }]
  files.editorState.hiddenCityIds = [b.id]
  files.editorState.countryOrder = files.places.places.filter(p => p.subtype === 'country').map(p => p.id).reverse()
  files.editorState.cityOrderByCountry = { [country.id]: [c.id, b.id, a.id] }
  files.travel.display.navigationHiddenCityIds = [c.id]
  files.media = { schemaVersion: 3, generatedAt: 'synthetic-original-time', customHeader: { nested: [true, null] }, items: [
    { id: 'synthetic-photo', placeId: a.id, kind: 'photo', scope: 'city', src: '/synthetic/photo.webp', originalFileName: 'neutral.jpg', isCover: true, status: 'ready', variants: { thumb: { src: '/synthetic/thumb.webp', width: 0 }, original: { src: '/synthetic/original.jpg' } }, title: { names: { 'zh-Hans': '示例图片', en: 'Neutral photo' }, originalLanguage: 'en' }, custom: { camera: 'synthetic' } } as V2Files['media']['items'][number],
    { id: 'synthetic-drone', placeId: b.id, kind: 'video', scope: 'city', src: '/synthetic/flight.mp4', originalFileName: 'neutral.mp4', isCover: false, status: 'needsMetadata', date: '2025', captureType: 'drone', altitudeMeters: 0, relativeAltitudeMeters: 0 },
  ] }
  files.editorState.hiddenMediaIds = ['synthetic-photo']
  files.editorState.hiddenDroneMediaIds = ['synthetic-drone']
  files.editorState.mediaOrderByCity = { [a.id]: ['synthetic-photo'] }
  files.editorState.coverMediaByCity = { [a.id]: 'synthetic-photo' }
  files.editorState.droneOrderByCity = { [b.id]: ['synthetic-drone'] }
  return files
}
