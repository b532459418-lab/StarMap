/**
 * The native public sample (3C-5A): `src/data/sample/`, its generator's command line (`npm run sample:build`) and the
 * privacy audit's rules for it (`npm run privacy:check`, ./privacy-audit.mjs). The V2 sample's rules (./compat/v2-sample.mjs)
 * stay as they are: the public build still reads the V2 files until 3C-5B.
 *
 * The audit's rules, the V2 sample's carried over to the new format:
 * - the directory holds only the source, its generator, its test and the generated read model;
 * - the read model is valid JSON, a `starmap.read-model` of origin `sample`, passes the full check (Core's row rules),
 *   and equals what the source generates now, byte for byte (an edit of the source was regenerated, and nothing was
 *   edited in the generated file by hand);
 * - the public-sample marks: every entity and anchor is public, and the footprint and Want to Go file headers declare
 *   `privacy_level = public-sample`;
 * - it is runnable: at least one footprint entry and one Want to Go entry;
 * - neutral ids: footprint record ids start with `sample_`, Want to Go record ids with `wtg_`;
 * - nothing hidden: no hidden view item and no row in a hidden scope;
 * - nothing the local editor wrote (`source: local-editor`);
 * - no local path, in the read model or in the source: no drive letter, UNC or backslash path, home directory, file
 *   URL, private root, Inbox or private media URL.
 * Errors are English, like the rest of the audit, and name ids and paths only.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { webRoot } from './private-profile.mjs'
import { OFFICIAL, OFFICIAL_POLICY, V2_SOURCES } from '../src/data/store/officialDefinitions.ts'
import { SAMPLE_READ_MODEL_FILE_NAME, sampleReadModelText } from '../src/data/sample/sampleBuild.ts'
import { readReadModel, validateReadModel } from '../src/worldgraph/readModel/check.ts'

export const SAMPLE_DIRECTORY = path.join(webRoot, 'src', 'data', 'sample')
export const SAMPLE_SOURCE_FILE_NAME = 'sampleSource.ts'
/** Every file the directory may hold. */
export const SAMPLE_ALLOWED_FILES = Object.freeze([SAMPLE_READ_MODEL_FILE_NAME, 'sample.test.ts', 'sampleBuild.ts', SAMPLE_SOURCE_FILE_NAME].sort())

/** Text that names a local path (see the file header). */
export const LOCAL_PATH_PATTERNS = Object.freeze([
  /(^|[^A-Za-z])[A-Za-z]:[\\/]/, /\\\\/, /\/(Users|home)\//, /file:/i, /06_private/i, /\.starmap-private/i, /MediaInbox/i, /\/media\/user\//i, /AppData/i,
])
const HIDDEN_SCOPE = /^starmap:(hidden\/|editor\/hidden-)/

const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * The audit of the sample directory (or a copy of it): error lines; empty when it passes. `expectedText` gives the text
 * the source generates (tests of a modified copy pass their own).
 */
export function auditPublicSampleDirectory(directory = SAMPLE_DIRECTORY, { expectedText = sampleReadModelText } = {}) {
  const label = 'src/data/sample'
  if (!existsSync(directory) || !statSync(directory).isDirectory()) return [`${label}/ must exist: it is the source of the public sample.`]
  const errors = []
  const unexpected = readdirSync(directory).filter((name) => !SAMPLE_ALLOWED_FILES.includes(name)).sort()
  if (unexpected.length) errors.push(`${label}/ may contain only ${SAMPLE_ALLOWED_FILES.join(', ')}:\n${unexpected.map((name) => `  - ${name}`).join('\n')}`)

  const sourceFile = path.join(directory, SAMPLE_SOURCE_FILE_NAME)
  const modelFile = path.join(directory, SAMPLE_READ_MODEL_FILE_NAME)
  if (!existsSync(sourceFile)) errors.push(`${label}/${SAMPLE_SOURCE_FILE_NAME} must exist.`)
  if (!existsSync(modelFile)) return [...errors, `${label}/${SAMPLE_READ_MODEL_FILE_NAME} must exist (npm run sample:build).`]
  const text = readFileSync(modelFile, 'utf8')
  let model
  try { model = JSON.parse(text) } catch { return [...errors, `${label}/${SAMPLE_READ_MODEL_FILE_NAME} must be valid JSON.`] }
  try { readReadModel(model); validateReadModel(model, OFFICIAL_POLICY) } catch (error) {
    return [...errors, `${label}/${SAMPLE_READ_MODEL_FILE_NAME} must pass the full read-model check (${error?.code ?? 'error'} ${error?.path ?? ''}).`]
  }
  if (text !== expectedText()) errors.push(`${label}/${SAMPLE_READ_MODEL_FILE_NAME} must be what ${SAMPLE_SOURCE_FILE_NAME} generates: run npm run sample:build.`)
  if (model.origin !== 'sample') errors.push(`${label}/${SAMPLE_READ_MODEL_FILE_NAME} must have origin = sample.`)

  const list = (rows) => rows.map((row) => `  - ${row.id}`).join('\n')
  const notPublic = [...model.entities.filter((row) => row.visibility !== 'public'), ...model.anchors.filter((row) => row.visibility !== undefined && row.visibility !== 'public')]
  if (notPublic.length) errors.push(`${label}: every entity and anchor must be public:\n${list(notPublic)}`)
  const headers = model.sources.find((row) => row.id === V2_SOURCES.import)?.extensions?.v2
  for (const file of ['travel', 'wantToGo']) {
    if (!plain(headers) || !plain(headers[file]) || headers[file].privacy_level !== 'public-sample') errors.push(`${label}: the ${file} header must declare privacy_level = public-sample.`)
  }
  const footprints = model.entries.filter((row) => row.layerId === OFFICIAL.travel)
  const wishes = model.entries.filter((row) => row.layerId === OFFICIAL.wantToGo && row.source.sourceId === V2_SOURCES.wantToGo)
  if (!footprints.length) errors.push(`${label} needs at least one runnable footprint entry.`)
  if (!wishes.length) errors.push(`${label} needs at least one Want to Go entry.`)
  const badFootprints = footprints.filter((row) => !row.source.recordId.startsWith('sample_'))
  if (badFootprints.length) errors.push(`${label}: footprint record ids must start with sample_:\n${list(badFootprints)}`)
  const badWishes = wishes.filter((row) => !row.source.recordId.startsWith('wtg_'))
  if (badWishes.length) errors.push(`${label}: Want to Go record ids must start with wtg_:\n${list(badWishes)}`)
  const hidden = [...model.viewItems.filter((row) => row.hidden || HIDDEN_SCOPE.test(row.scope)), ...model.viewSettings.filter((row) => HIDDEN_SCOPE.test(row.scope))]
  if (hidden.length) errors.push(`${label} must not contain hidden content:\n${list(hidden)}`)
  const editor = [...model.entities, ...model.entries].filter((row) => plain(row.extensions?.v2) && row.extensions.v2.source === 'local-editor')
  if (editor.length) errors.push(`${label} must not contain rows written by the local editor (source = local-editor):\n${list(editor)}`)
  const texts = [[SAMPLE_READ_MODEL_FILE_NAME, text], ...(existsSync(sourceFile) ? [[SAMPLE_SOURCE_FILE_NAME, readFileSync(sourceFile, 'utf8')]] : [])]
  for (const [name, content] of texts) {
    if (LOCAL_PATH_PATTERNS.some((pattern) => pattern.test(content))) errors.push(`${label}/${name} must not contain a local path.`)
  }
  return errors
}

/** `npm run sample:build [-- --check]`: write the generated read model, or (--check) only compare. Returns the exit code. */
export async function runSampleBuild(argv, { directory = SAMPLE_DIRECTORY, log = console.log, logError = console.error } = {}) {
  const check = argv.length === 1 && argv[0] === '--check'
  if (argv.length && !check) {
    logError('用法：npm run sample:build [-- --check]')
    return 1
  }
  const target = path.join(directory, SAMPLE_READ_MODEL_FILE_NAME)
  const text = sampleReadModelText()
  const current = existsSync(target) ? readFileSync(target, 'utf8') : undefined
  if (check) {
    if (current === text) { log(`${SAMPLE_READ_MODEL_FILE_NAME} 与样例源一致。`); return 0 }
    logError(`${SAMPLE_READ_MODEL_FILE_NAME} 与样例源不一致：运行 npm run sample:build。`)
    return 1
  }
  if (current === text) { log(`${SAMPLE_READ_MODEL_FILE_NAME} 已是最新，没有改动。`); return 0 }
  await writeFile(target, text, 'utf8')
  log(`已生成 ${path.relative(webRoot, target).replaceAll('\\', '/')}。接着运行 npm run privacy:check 与 npm test。`)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await runSampleBuild(process.argv.slice(2))
}
