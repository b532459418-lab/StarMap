import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isPrivateTrackedPath } from './privacy-paths.mjs'

const violations = (paths) => {
  for (const filePath of paths) assert.equal(isPrivateTrackedPath(filePath), true, filePath)
}
const allowed = (paths) => {
  for (const filePath of paths) assert.equal(isPrivateTrackedPath(filePath), false, filePath)
}

test('A private root inside the repository is private at any depth', () => {
  violations([
    '06_private/data/v2/places.json',
    '06_private/MediaInbox/Japan/Tokyo/photo.jpg',
    '06_private/media/user/abc/original.jpg',
    '06_private/operations/media-jobs/job.json',
    '01_Web/06_private/config/.env',
    '.starmap-private/data/v2/places.json',
    '01_Web/.starmap-private/media/user/x.webp',
    '06_PRIVATE/data/v2/places.json',
    '06_private\\data\\v2\\places.json',
  ])
  allowed(['03_Reference/06_private.md', 'docs/starmap-private-notes.md'])
})

test('Files ending in .local and files with .local. are private', () => {
  violations(['.env.local', '01_Web/.env.local', 'notes.local', 'docs/config.LOCAL', '01_Web/src/data/generated/media.local.json', 'want-to-go.local.json'])
  allowed(['01_Web/src/data/localEditorApi.ts', 'docs/local-backup.md', '01_Web/src/locales/zh/common.json'])
})

test('.env files are private in every directory; only .env.example is public', () => {
  violations(['.env', '.env.production', '.envrc', '01_Web/.env', '01_Web/.env.development', 'docs/.env', '02_Assets/MediaInbox/_country-template/.env'])
  allowed(['01_Web/.env.example', '.env.example', 'docs/.env.example'])
})

test('Build output under 01_Web/dist is private', () => {
  violations(['01_Web/dist/index.html', '01_Web/dist/assets/index-abc.js', '01_Web/dist/media/user/abc/original.jpg', '01_Web\\dist\\index.html'])
  allowed(['01_Web/scripts/dist-check.mjs', 'docs/dist/readme.md'])
})

test('The earlier rules are unchanged', () => {
  violations([
    '02_Assets/PrivateData/travel.json',
    '01_Web/public/media/user/abc/thumb.webp',
    '01_Web/src/data/generated/index.json',
    '01_Web/src/data/travel_map_export.json',
    '02_Assets/MediaInbox/Japan/Tokyo/photo.jpg',
  ])
})

test('The MediaInbox exceptions stay public', () => {
  allowed(['02_Assets/MediaInbox/README.md', '02_Assets/MediaInbox/_country-template/README.md', '02_Assets/MediaInbox/_country-template/_city-template/media.json'])
})

test('Ordinary source, docs and samples are public', () => {
  allowed(['01_Web/src/App.tsx', '01_Web/src/data/v2-sample/places.json', 'README.md', '.gitignore', '01_Web/package.json', '03_Reference/want-to-go.schema.json'])
})
