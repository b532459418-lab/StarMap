/**
 * Which data a private root holds (3C-3, design 3B §7 and §10; 3C-4d): the one decision shared by the local editor
 * plugin, the media command lines, `npm run library:recover` and the store tools.
 *
 * Since 3C-4d the new library is the only way personal data is written. privateDataState gives one of four states:
 * - 'store': `<private-root>/data/store/world.sqlite` exists. The App reads and writes the store.
 * - 'migration-required': no store, but V2 data (one of the five files under `data/v2/`; reason 'v2') or legacy-format
 *   files that were never migrated to V2 (reason 'legacy', ./legacy-data.mjs). The data is shown read-only; every write
 *   is refused until `npm run store:migrate -- --apply` (for 'legacy': the migration of commit 4fd32a9 first).
 * - 'needs-recovery': no store and no data, but something is left under `data/store/` (a journal, a staging file of a
 *   migration or restore). Nothing creates a library over it; `npm run library:recover` lists it and sets it aside.
 * - 'empty': none of these. The personal dev server creates an empty library when it starts (./store-init.mjs);
 *   builds, read-only checks and command lines never create one.
 * privateDataSource keeps the two-way answer ('store' or 'v2') of the tools that only ask whether a store exists.
 *
 * Only the presence of files is looked at, never their content. A store that cannot be opened is still 'store' (the
 * App then shows the error and never falls back to V2), so a private root never has two writers.
 *
 * Kept free of `node:sqlite` and the store host, because vite.config.ts loads the plugin (and so this file) for every
 * build. STORE_FILE_SEGMENTS is the store host's STORE_RELATIVE_PATH (private-data-source.test.mjs checks they agree).
 */
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { legacyDataStateOf } from './legacy-data.mjs'

/** The store file under the private root (store-host.mjs STORE_RELATIVE_PATH). */
export const STORE_FILE_SEGMENTS = Object.freeze(['data', 'store', 'world.sqlite'])

/** `<private-root>/data/store/world.sqlite` for `privatePaths` (getPrivatePaths()). */
export const storeFileOf = (privatePaths) => path.join(privatePaths.root, ...STORE_FILE_SEGMENTS)

/** 'store' when the store file exists under the private root, otherwise 'v2'. */
export const privateDataSource = (privatePaths) => (existsSync(storeFileOf(privatePaths)) ? 'store' : 'v2')

/** The names under `data/store/` (none when the folder is absent): without the store file, every one is a leftover. */
export function storeResidueOf(privatePaths) {
  try { return readdirSync(path.dirname(storeFileOf(privatePaths))).sort() } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return []
    throw error
  }
}

/**
 * The state of a private root (see the file header): { state, reason?, residue }. `reason` is 'v2' or 'legacy' for
 * 'migration-required'; `residue` the names left under `data/store/` when there is no store file.
 */
export function privateDataState(privatePaths) {
  if (existsSync(storeFileOf(privatePaths))) return Object.freeze({ state: 'store', residue: Object.freeze([]) })
  const residue = Object.freeze(storeResidueOf(privatePaths))
  const files = legacyDataStateOf(privatePaths)
  if (files.v2Files.length > 0) return Object.freeze({ state: 'migration-required', reason: 'v2', residue })
  if (files.legacyFiles.length > 0) return Object.freeze({ state: 'migration-required', reason: 'legacy', residue })
  if (residue.length > 0) return Object.freeze({ state: 'needs-recovery', residue })
  return Object.freeze({ state: 'empty', residue })
}
