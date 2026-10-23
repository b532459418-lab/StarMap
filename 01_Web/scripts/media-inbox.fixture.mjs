/**
 * Test helpers for the new library's media (3C-4c): an invented place registry (two countries with user-assigned ISO
 * codes XA / XB and three cities) and a synthetic Inbox of plain-colour images that sharp makes on the spot. No real
 * place, no real photo. Not a test file itself; not imported by the App.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'

/** Fixed UUIDv7 place ids. */
export const PLACE = Object.freeze({
  synthland: '019a1000-0000-7000-8000-000000000001',
  harbor: '019a1000-0000-7000-8000-000000000002',
  hill: '019a1000-0000-7000-8000-000000000003',
  secondLand: '019a1000-0000-7000-8000-000000000004',
  river: '019a1000-0000-7000-8000-000000000005',
})

/** The V2 places file of the invented registry. */
export const syntheticPlaces = () => ({
  schema_version: 1,
  generated_at: '2026-10-01T00:00:00.000Z',
  places: [
    { id: PLACE.synthland, subtype: 'country', names: { 'zh-Hans': '合成国', en: 'Synthland' }, externalIds: { iso3166Alpha2: 'XA' }, location: { lat: 10, lng: 20 } },
    { id: PLACE.harbor, subtype: 'city', names: { 'zh-Hans': '港镇', en: 'Harbor Town' }, partOf: PLACE.synthland, location: { lat: 10.1, lng: 20.1 } },
    { id: PLACE.hill, subtype: 'city', names: { 'zh-Hans': '山镇', en: 'Hill Town' }, partOf: PLACE.synthland, location: { lat: 10.2, lng: 20.2 } },
    { id: PLACE.secondLand, subtype: 'country', names: { 'zh-Hans': '第二国', en: 'Second Land' }, externalIds: { iso3166Alpha2: 'XB' }, location: { lat: 30, lng: 40 } },
    { id: PLACE.river, subtype: 'city', names: { 'zh-Hans': '河镇', en: 'River Town' }, partOf: PLACE.secondLand, location: { lat: 30.1, lng: 40.1 } },
  ],
})

export const COLOR = Object.freeze({
  red: { r: 200, g: 30, b: 30 }, green: { r: 30, g: 160, b: 60 }, blue: { r: 30, g: 60, b: 200 },
  yellow: { r: 230, g: 200, b: 40 }, grey: { r: 120, g: 120, b: 120 }, purple: { r: 120, g: 40, b: 160 },
})

export const writeJson = async (target, value) => {
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

/** A plain-colour JPEG: another colour is another content. */
export const makeImage = async (target, { width = 64, height = 48, color }) => {
  await mkdir(path.dirname(target), { recursive: true })
  await sharp({ create: { width, height, channels: 3, background: color } }).jpeg({ quality: 90 }).toFile(target)
}

/**
 * The synthetic Inbox:
 *   Synthland/Harbor Town/place.json → Harbor Town; photos/a.jpg (red), photos/b.jpg (green), photos/a-copy.jpg (red again)
 *   Synthland/Hill Town/photos/c.jpg (blue): the city folder matches by name only (a folder binding to confirm)
 *   Second Land/place.json, River Town/place.json; drone/pano-1.jpg (yellow, 2:1) with a media.json entry
 * Returns the portable paths of the files.
 */
export async function writeSyntheticInbox(paths) {
  const inbox = paths.inboxRoot
  await writeJson(path.join(inbox, 'Synthland', 'place.json'), { placeId: PLACE.synthland })
  await writeJson(path.join(inbox, 'Synthland', 'Harbor Town', 'place.json'), { placeId: PLACE.harbor })
  await makeImage(path.join(inbox, 'Synthland', 'Harbor Town', 'photos', 'a.jpg'), { color: COLOR.red })
  await makeImage(path.join(inbox, 'Synthland', 'Harbor Town', 'photos', 'b.jpg'), { color: COLOR.green })
  await makeImage(path.join(inbox, 'Synthland', 'Harbor Town', 'photos', 'a-copy.jpg'), { color: COLOR.red })
  await makeImage(path.join(inbox, 'Synthland', 'Hill Town', 'photos', 'c.jpg'), { color: COLOR.blue })
  await writeJson(path.join(inbox, 'Second Land', 'place.json'), { placeId: PLACE.secondLand })
  await writeJson(path.join(inbox, 'Second Land', 'River Town', 'place.json'), { placeId: PLACE.river })
  await makeImage(path.join(inbox, 'Second Land', 'River Town', 'drone', 'pano-1.jpg'), { width: 200, height: 100, color: COLOR.yellow })
  await writeJson(path.join(inbox, 'Second Land', 'River Town', 'media.json'), {
    'drone/pano-1.jpg': { kind: 'panorama360', titleEn: 'Synthetic panorama', date: '2026-07-03', resolution: '200 × 100' },
  })
  return {
    a: 'MediaInbox/Synthland/Harbor Town/photos/a.jpg',
    b: 'MediaInbox/Synthland/Harbor Town/photos/b.jpg',
    aCopy: 'MediaInbox/Synthland/Harbor Town/photos/a-copy.jpg',
    c: 'MediaInbox/Synthland/Hill Town/photos/c.jpg',
    pano: 'MediaInbox/Second Land/River Town/drone/pano-1.jpg',
  }
}

/**
 * A V2 library the V2 importer has imported: the invented registry and the synthetic Inbox (the Hill Town binding
 * confirmed, so its place.json is written; 3C-5 E: written by ./v2-media-import.fixture.mjs from the importer's plan).
 * Returns the Inbox paths of writeSyntheticInbox.
 */
export async function importedV2Library(paths, { now = '2026-10-16T00:00:00.000Z' } = {}) {
  await writeJson(paths.v2FilePaths.places, syntheticPlaces())
  const files = await writeSyntheticInbox(paths)
  const { writeV2MediaImport } = await import('./v2-media-import.fixture.mjs')
  await writeV2MediaImport({ privatePaths: paths, acceptFolderBindings: true, now: () => new Date(now) })
  return files
}

/** A plain-colour JPEG as bytes (an upload's body). */
export const imageBytes = ({ width = 64, height = 48, color }) => sharp({ create: { width, height, channels: 3, background: color } }).jpeg({ quality: 90 }).toBuffer()

/** The absolute file of a portable `MediaInbox/…` path. */
export const inboxFile = (paths, portable) => path.join(paths.inboxRoot, ...portable.split('/').slice(1))
