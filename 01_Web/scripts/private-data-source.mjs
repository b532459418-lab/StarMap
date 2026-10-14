/**
 * Which data a private root is read from and written to (3C-3, design 3B §7 and §10): the one decision shared by the
 * local editor plugin, `npm run library:recover` and the store tools (`store:migrate`, `store:backup`, `store:restore`,
 * `store:export-v2`).
 *
 * - 'store' (the experimental new-library mode): `<private-root>/data/store/world.sqlite` exists. It is created only by
 *   `npm run store:migrate -- --apply` or `npm run store:restore`; the App then reads the store and only the want-to-go
 *   update is written (scripts/store-session.mjs).
 * - 'v2' (the default): anything else. The five files under `data/v2/` are read and written as before.
 *
 * Nothing else is looked at: not the V2 files, not the file's content. A store that cannot be opened is still 'store'
 * (the App then shows the error and never falls back to V2), so a private root never has two writers.
 *
 * Kept free of `node:sqlite` and the store host, because vite.config.ts loads the plugin (and so this file) for every
 * build. STORE_FILE_SEGMENTS is the store host's STORE_RELATIVE_PATH (private-data-source.test.mjs checks they agree).
 */
import { existsSync } from 'node:fs'
import path from 'node:path'

/** The store file under the private root (store-host.mjs STORE_RELATIVE_PATH). */
export const STORE_FILE_SEGMENTS = Object.freeze(['data', 'store', 'world.sqlite'])

/** `<private-root>/data/store/world.sqlite` for `privatePaths` (getPrivatePaths()). */
export const storeFileOf = (privatePaths) => path.join(privatePaths.root, ...STORE_FILE_SEGMENTS)

/** 'store' when the store file exists under the private root, otherwise 'v2'. */
export const privateDataSource = (privatePaths) => (existsSync(storeFileOf(privatePaths)) ? 'store' : 'v2')
