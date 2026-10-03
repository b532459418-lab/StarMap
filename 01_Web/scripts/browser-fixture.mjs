import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { integrityProblems } from '../src/data/v2write/transaction.ts'

export const fixtureIds = Object.freeze({
  iceland: '019b76da-a801-7000-8000-000000000001',
  reykjavik: '019b76da-a804-7000-8000-000000000004',
  torshavn: '019b76da-a807-7000-8000-000000000007',
  nuuk: '019b76da-a80c-7000-8000-00000000000c',
})
export const fixtureFileNames = Object.freeze({ places: 'places.local.json', travel: 'travel-map.local.json', wantToGo: 'want-to-go.local.json', editorState: 'editor-state.local.json', media: 'user-media.local.json' })

/** Only neutral tracked unit-test data; no owner data or environment files. */
export async function createBrowserFixture(root, { large = false } = {}) {
  const files = JSON.parse(await readFile(new URL('../src/data/v2write/fixtures/migrated-files.json', import.meta.url), 'utf8'))
  files.media.items = []
  files.editorState.coverMediaByCity = {}
  files.editorState.hiddenCityIds = []
  files.wantToGo.privacy_level = 'local-only'
  if (large) {
    for (let index = 0; index < 1000; index++) {
      const id = `019b76da-b000-7000-8000-${(index + 1).toString(16).padStart(12, '0')}`
      files.places.places.push({ id, subtype: 'city', names: { en: `Benchmark place ${index.toString().padStart(4, '0')}`, 'zh-Hans': `基准地点 ${index}` }, partOf: fixtureIds.iceland, location: { lat: 63.5 + index / 10000, lng: -19.5 + index / 10000 } })
      files.wantToGo.items.push({ id: `benchmark-${index}`, placeId: id, hidden: false, addedAt: '2026-01-01', note: 'Synthetic performance fixture' })
    }
  }
  const problems = integrityProblems(files)
  if (problems.length) throw new Error(`Invalid browser fixture: ${problems.join('; ')}`)
  await mkdir(path.join(root, 'data', 'v2'), { recursive: true })
  await mkdir(path.join(root, 'config'), { recursive: true })
  for (const [key, name] of Object.entries(fixtureFileNames)) await writeFile(path.join(root, 'data', 'v2', name), JSON.stringify(files[key], null, 2) + '\n')
  return files
}
