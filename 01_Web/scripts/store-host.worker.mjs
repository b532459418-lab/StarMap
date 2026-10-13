/**
 * Fault-injection probe for the store host tests (3C-2). Reads a JSON spec, then
 * - mode 'lease': takes the library operation lease and pauses inside it;
 * - mode 'open': opens the store for writing (a writer session) and pauses at 'opened';
 * - mode 'commit': opens the store with the real lease and commits `request`, pausing at `phase`
 *   ('leased', 'begun', 'deleted', 'written', 'before-commit', 'committed').
 * At the pause it prints `paused:<phase>` and blocks; the test then kills the process for real.
 * If nobody kills it, it exits with 94 after the bounded wait. A commit that runs to its end exits with 95.
 */
import { readFileSync, writeSync } from 'node:fs'
import { withLibraryOperation } from './library-operation-lock.mjs'
import { openStore } from './store-host.mjs'

const spec = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const pause = (name) => {
  writeSync(1, `paused:${name}\n`)
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30_000)
  process.exit(94)
}

if (spec.mode === 'lease') {
  await withLibraryOperation({ root: spec.root }, () => pause('leased'))
} else if (spec.mode === 'open') {
  // A writer session that never reaches close().
  openStore(spec.file, { privatePaths: { root: spec.root } })
  pause('opened')
} else {
  const handle = openStore(spec.file, {
    privatePaths: { root: spec.root },
    now: () => spec.now,
    unsafeTestPhase: (name) => { if (name === spec.phase) pause(name) },
  })
  const result = await handle.commit(spec.request)
  writeSync(1, `result:${result.status}\n`)
  await handle.close()
  process.exitCode = 95
}
