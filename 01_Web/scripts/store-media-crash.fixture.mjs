/**
 * Test helper for store-media-faults.test.mjs (not a test file; not imported by the App): one media write of the new
 * library in a child process that dies at a chosen point (SIGKILL, so no cleanup runs and the library lock stays, as
 * after a crash). Arguments: <private root> <scenario> [input as JSON].
 *   import-before-commit  an import, killed once its generated files are written, before its commit;
 *   delete-after-commit   a deletion (input { cityId, ids }), killed right after its commit, before the file run;
 *   drain-midway          the queued deletions, killed when the second file is about to be checked.
 * Prints "not killed" and exits 3 when the point is never reached.
 */
import { sha256File } from './file-hash.mjs'
import { withLibraryOperation } from './library-operation-lock.mjs'
import { createMediaService, handleMediaStore } from './media-service.mjs'
import { storeFileOf } from './private-data-source.mjs'
import { getPrivatePaths } from './private-profile.mjs'
import { openStore } from './store-host.mjs'
import { uuidv7 } from '../src/data/canonical/uuidv7.ts'
import { OFFICIAL_POLICY } from '../src/data/store/officialDefinitions.ts'

const [root, scenario, inputText] = process.argv.slice(2)
const paths = getPrivatePaths({ STARMAP_PRIVATE_ROOT: root })
const die = () => process.kill(process.pid, 'SIGKILL')
const handle = openStore(storeFileOf(paths), { privatePaths: paths, policy: OFFICIAL_POLICY, writerSession: false })
const adapter = handleMediaStore(handle)
const store = scenario === 'delete-after-commit'
  ? { ...adapter, commit: async (request, options) => { await adapter.commit(request, options); die() } }
  : adapter
let checked = 0
const hashFile = scenario === 'drain-midway' ? async (file) => { checked += 1; if (checked === 2) die(); return sha256File(file) } : sha256File

await withLibraryOperation(paths, async (leaseToken) => {
  const service = createMediaService({ privatePaths: paths, store, hashFile })
  if (scenario === 'import-before-commit') {
    await service.importInbox({ requestId: uuidv7(), leaseToken, onStage: async (stage) => { if (stage === 'generated') die() } })
  } else if (scenario === 'delete-after-commit') {
    await service.deleteMedia({ input: JSON.parse(inputText), requestId: uuidv7(), leaseToken })
  } else if (scenario === 'drain-midway') {
    await service.drain(leaseToken)
  }
})
await handle.close()
console.log('not killed')
process.exitCode = 3
