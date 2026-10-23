/**
 * Test helper (3C-5 E spec §2.3): a V2 library with imported media, for the tests whose input is one (the migration, the
 * media seeding, backups of V2 roots, the media endpoints on a migrated library). The V2 media import no longer writes
 * (3C-4d: media imports write the new library only; 3C-5 E removed the write path the tests had kept): this helper takes
 * the importer's own read-only plan (scanV2MediaImport: the scan, the content-addressed items and covers, the folder
 * bindings) and writes what it describes with the publisher the new library's import uses (publishGeneratedFiles): the
 * generated files, the confirmed folder bindings (place.json), the V2 media catalog and the media source index. The
 * catalog must pass the V2 integrity check with the other four files, as the import required.
 *
 * Why written here and not frozen: the Inbox images are made by sharp on the spot, so their hashes (and the catalog's
 * ids) follow the sharp in use; a frozen catalog would stop matching them, and committing the images would put binary
 * files into the repository.
 *
 * Not imported by the App or by any command (git grep: tests and fixtures only).
 */
import path from 'node:path'
import { atomicJsonWrite } from './json-file.mjs'
import { publishGeneratedFiles, scanV2MediaImport } from './v2-media-import.mjs'
import { catalogIntegrityProblems, mediaCatalogFileOf, mediaSourceIndexFileOf, placeConfigOf, sourcesByIdOf } from '../src/data/v2media/importPlan.ts'

const toPosix = (value) => value.split(path.sep).join('/')

/**
 * Write what the V2 import planned for the Inbox of `privatePaths` (see the file header). Throws when the plan has
 * problems, or folder bindings found by name and no `acceptFolderBindings`; nothing is written then. `now` gives the
 * catalog's and the index's generatedAt. Resolves { mediaIds, catalog, index, pins }.
 */
export async function writeV2MediaImport({ privatePaths, now = () => new Date(), acceptFolderBindings = false }) {
  const scan = await scanV2MediaImport({ privatePaths, now, log: () => {}, logError: () => {} })
  if (scan.errors.length > 0) throw Object.assign(new Error(`The V2 import plan has problems:\n${scan.errors.join('\n')}`), { problems: scan.errors })
  if (scan.pins.length > 0 && !acceptFolderBindings) {
    throw Object.assign(new Error(`The V2 import plan has ${scan.pins.length} folder bindings to confirm (acceptFolderBindings)`), { unconfirmedBindings: scan.pins.length })
  }
  const generatedAt = now().toISOString()
  const catalog = mediaCatalogFileOf(scan.items, generatedAt)
  const problems = catalogIntegrityProblems(scan.files, catalog, now())
  if (problems.length > 0) throw new Error(`The V2 media catalog would not pass the integrity check: ${problems.slice(0, 5).join('; ')}`)
  for (const entry of scan.unique) await publishGeneratedFiles(entry)
  for (const pin of scan.pins) await atomicJsonWrite(path.join(pin.directory, 'place.json'), placeConfigOf(pin.placeId))
  await atomicJsonWrite(privatePaths.v2FilePaths.media, catalog)
  const relative = (filePath) => toPosix(path.relative(privatePaths.inboxRoot, filePath))
  const index = mediaSourceIndexFileOf(sourcesByIdOf(scan.planned.map((entry) => ({ id: entry.id, sourcePath: relative(entry.sourcePath) }))), generatedAt)
  await atomicJsonWrite(privatePaths.v2MediaSourceIndexPath, index)
  return { mediaIds: scan.items.map((item) => item.id), catalog, index, pins: scan.pins }
}
