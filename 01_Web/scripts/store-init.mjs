/**
 * An empty new library for a private root without any data (3C-4d, decision D-b A; review §8-1).
 *
 * The personal dev server calls createEmptyLibrary when it starts on a root in the state 'empty'
 * (./private-data-source.mjs); `npm run store:migrate -- --apply` calls it for an empty root too. Builds, read-only checks
 * and the media command lines never create a library.
 *
 * - The library is initialized in the formal model directly: one first request with the official definitions and the
 *   provenance sources the editing rules write rows under (the `v2:*` sources of 3C-4a's rule engine, until 3C-5 gives
 *   the edits native commands). It never goes through the V2 migration reader, so no V2 file is made up as empty.
 * - Under the library lease (the caller's, or one taken here), the state is decided again: anything but 'empty' (data
 *   appeared, a leftover under `data/store/`) refuses with E_STORE_NOT_EMPTY and creates nothing.
 * - Creation is exclusive (store-host createStore): an existing file is never touched, and a failure removes what this
 *   call created. The new library is closed normally and checked once (Core's validation and the host's tables).
 */
import { mkdirSync } from 'node:fs'
import { rmdir, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import { withLibraryOperation } from './library-operation-lock.mjs'
import { privateDataState, storeFileOf } from './private-data-source.mjs'
import { checkStoreFile, createStore } from './store-host.mjs'
import { StoreToolError } from './store-tool-error.mjs'
import { uuidv7 } from '../src/data/canonical/uuidv7.ts'
import { OFFICIAL_POLICY, V2_SOURCES, officialDefinitionCommands, v2SourceDefinition } from '../src/data/store/officialDefinitions.ts'

/** `kind` and `actor` of an empty library's first request. */
export const EMPTY_LIBRARY_KIND = 'store.create-empty'
export const EMPTY_LIBRARY_ACTOR = 'store:init'

/** The commands of an empty library: the official definitions, then the provenance sources the editing rules use. */
export const emptyLibraryCommands = () => [
  ...officialDefinitionCommands(),
  ...Object.values(V2_SOURCES).map((id) => ({ op: 'create', table: 'sources', value: v2SourceDefinition(id) })),
]

/**
 * Create the empty library of `privatePaths` (state 'empty'). Resolves { libraryId, revision }. `leaseToken` is a lease
 * the caller holds; `now`, `libraryId` and `requestId` are injectable (tests).
 */
export async function createEmptyLibrary(privatePaths, { leaseToken, now = new Date().toISOString(), libraryId = uuidv7(), requestId = uuidv7(), actor = EMPTY_LIBRARY_ACTOR } = {}) {
  return withLibraryOperation(privatePaths, async (lease) => {
    const decided = privateDataState(privatePaths)
    if (decided.state !== 'empty') {
      throw new StoreToolError('E_STORE_NOT_EMPTY', [`这个私人根不是空的（${decided.state}），没有创建新库。`])
    }
    const file = storeFileOf(privatePaths)
    const directory = path.dirname(file)
    const createdDirectory = await stat(directory).then(() => false, () => true)
    mkdirSync(directory, { recursive: true })
    let handle
    try {
      handle = await createStore(file, {
        libraryId, policy: OFFICIAL_POLICY, now: () => now,
        lock: (callback) => withLibraryOperation(privatePaths, () => callback(), { leaseToken: lease }),
        initial: { requestId, kind: EMPTY_LIBRARY_KIND, actor, commands: emptyLibraryCommands() },
      })
    } catch (error) {
      if (createdDirectory) await rmdir(directory).catch(() => {})
      throw error
    }
    const revision = handle.meta().revision
    await handle.close()
    const { problems } = await checkStoreFile(file, { policy: OFFICIAL_POLICY })
    if (problems.length) {
      await unlink(file).catch(() => {})
      if (createdDirectory) await rmdir(directory).catch(() => {})
      throw new StoreToolError('E_STORE_INIT_CHECK', problems)
    }
    return { libraryId, revision }
  }, { leaseToken })
}
