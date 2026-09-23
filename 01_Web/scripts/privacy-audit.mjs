import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const projectRoot = path.resolve(webRoot, '..')
const publicFiles = process.argv.includes('--manifest-stdin')
  ? readFileSync(0, 'utf8').split('\0').filter(Boolean)
  : []

const isPrivateTrackedPath = (filePath) => {
  const normalized = filePath.replaceAll('\\', '/')
  if (normalized.startsWith('02_Assets/PrivateData/')) return true
  if (normalized.startsWith('01_Web/public/media/user/')) return true
  if (normalized.startsWith('01_Web/src/data/generated/')) return true
  if (normalized.includes('.local.')) return true
  if (normalized === '01_Web/src/data/travel_map_export.json') return true
  if (normalized.startsWith('02_Assets/MediaInbox/')) {
    return normalized !== '02_Assets/MediaInbox/README.md'
      && !normalized.startsWith('02_Assets/MediaInbox/_country-template/')
  }
  if (/^01_Web\/\.env(?:\.|$)/.test(normalized)) return normalized !== '01_Web/.env.example'
  return false
}

const existingViolations = publicFiles.filter((filePath) =>
  isPrivateTrackedPath(filePath) && existsSync(path.join(projectRoot, filePath)),
)

// Only these tracked files may be named want-to-go*. Anything else, such as a renamed
// copy of the private want-to-go.local.json, is a violation even without `.local.`.
const allowedWantToGoPaths = new Set([
  '01_Web/src/data/want-to-go.sample.json',
  '03_Reference/want-to-go.schema.json',
  '01_Web/scripts/want-to-go-store.mjs',
  '01_Web/scripts/want-to-go-store.test.mjs',
])
const unexpectedWantToGoFiles = publicFiles.filter((filePath) => {
  const normalized = filePath.replaceAll('\\', '/')
  return path.posix.basename(normalized).toLowerCase().startsWith('want-to-go')
    && !allowedWantToGoPaths.has(normalized)
    && existsSync(path.join(projectRoot, filePath))
})

const samplePath = path.join(webRoot, 'src', 'data', 'travel-map.sample.json')
const sampleData = JSON.parse(readFileSync(samplePath, 'utf8'))
const errors = []
const gitignore = readFileSync(path.join(projectRoot, '.gitignore'), 'utf8')
const requiredIgnoreRules = [
  '06_private/',
  '.starmap-private/',
  '02_Assets/MediaInbox/*',
  '01_Web/public/media/user/',
  '01_Web/src/data/generated/*.local.*',
  '.env.*',
  '!.env.example',
]

if (publicFiles.length === 0) {
  errors.push('No public-file manifest was provided. Run this audit through npm run privacy:check.')
}

if (existingViolations.length > 0) {
  errors.push(`Private paths are tracked:\n${existingViolations.map((filePath) => `  - ${filePath}`).join('\n')}`)
}
const missingIgnoreRules = requiredIgnoreRules.filter((rule) => !gitignore.split(/\r?\n/).includes(rule))
if (missingIgnoreRules.length > 0) {
  errors.push(`Required .gitignore safeguards are missing:\n${missingIgnoreRules.map((rule) => `  - ${rule}`).join('\n')}`)
}
if (sampleData.privacy_level !== 'public-sample') {
  errors.push('travel-map.sample.json must declare privacy_level = public-sample.')
}
if (!Array.isArray(sampleData.records) || sampleData.records.length === 0) {
  errors.push('travel-map.sample.json needs at least one runnable sample record.')
}

if (unexpectedWantToGoFiles.length > 0) {
  errors.push(`Only the neutral want-to-go sample, its schema, and the store scripts may be tracked:\n${unexpectedWantToGoFiles.map((filePath) => `  - ${filePath}`).join('\n')}`)
}

const wantToGoSamplePath = path.join(webRoot, 'src', 'data', 'want-to-go.sample.json')
let wantToGoSample
try {
  wantToGoSample = JSON.parse(readFileSync(wantToGoSamplePath, 'utf8'))
} catch (error) {
  errors.push(`want-to-go.sample.json must exist and be valid JSON: ${error.message}`)
}
const wantToGoSampleItems = Array.isArray(wantToGoSample?.items) ? wantToGoSample.items : []
if (wantToGoSample !== undefined) {
  const describeItem = (item, index) => (typeof item?.id === 'string' ? item.id : `item ${index + 1}`)
  const listItems = (predicate) => wantToGoSampleItems
    .map((item, index) => (predicate(item) ? `  - ${describeItem(item, index)}` : undefined))
    .filter(Boolean)
    .join('\n')

  if (wantToGoSample?.schema_version !== 1) {
    errors.push('want-to-go.sample.json must declare schema_version = 1.')
  }
  if (wantToGoSample?.privacy_level !== 'public-sample') {
    errors.push('want-to-go.sample.json must declare privacy_level = public-sample.')
  }
  if (wantToGoSampleItems.length === 0) {
    errors.push('want-to-go.sample.json needs a non-empty items array.')
  }
  const badIds = listItems((item) => typeof item?.id !== 'string' || !item.id.startsWith('wtg_'))
  if (badIds) errors.push(`want-to-go.sample.json item ids must start with wtg_:\n${badIds}`)
  const hiddenItems = listItems((item) => item?.hidden === true)
  if (hiddenItems) errors.push(`want-to-go.sample.json must not contain hidden items:\n${hiddenItems}`)
  const editorItems = listItems((item) => item?.source === 'local-editor')
  if (editorItems) errors.push(`want-to-go.sample.json must not contain items written by the local editor (source = local-editor):\n${editorItems}`)
}

const droneSource = readFileSync(path.join(webRoot, 'src', 'data', 'droneMedia.ts'), 'utf8')
if (droneSource.includes('builtInDroneMediaItems') || /src:\s*['"]\/media\//.test(droneSource)) {
  errors.push('droneMedia.ts still contains built-in media instead of the private local catalog.')
}

if (errors.length > 0) {
  console.error(`StarMap privacy audit failed (${errors.length}):`)
  for (const error of errors) console.error(`\n${error}`)
  process.exitCode = 1
} else {
  console.log('StarMap privacy audit passed.')
  console.log(`Tracked and unignored public files checked: ${publicFiles.length}`)
  console.log(`Neutral sample records: ${sampleData.records.length}`)
  console.log(`Neutral want-to-go sample items: ${wantToGoSampleItems.length}`)
  console.log('Required .gitignore safeguards are present.')
  console.log('Private Inbox, generated media, local catalogs, local travel data, and environment files are outside the tracked public boundary.')
  console.log('Note: this checks the current tree. Publish from a clean repository so earlier private Git history is not inherited.')
}
