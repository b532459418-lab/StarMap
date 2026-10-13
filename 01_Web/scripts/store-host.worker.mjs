/**
 * Fault-injection probe for the store host tests (3C-2, 3C-2b). Reads a JSON spec, then
 * - mode 'lease': takes the library operation lease and pauses inside it;
 * - mode 'open': opens the store for writing (a writer session) and pauses at 'opened';
 * - mode 'commit': opens the store (ordinary writes check the library lock, they take no lease)
 *   and commits `request`, pausing at `phase` ('probed', 'begun', 'deleted', 'written',
 *   'before-commit', 'committed'). With `lease: true` it first takes the library lease and commits
 *   with its leaseToken, as a media operation or a migration will;
 * - mode 'race': opens the store, prints `ready`, waits for a line on stdin, commits `request` and
 *   prints `result:<json>` (status, or code and outcome), then closes and exits 0. With `holdFile`
 *   it holds its write transaction open after BEGIN IMMEDIATE until that file exists;
 * At a pause it prints `paused:<phase>` and blocks; the test then kills the process for real.
 * If nobody kills it, it exits with 94 after the bounded wait. A commit that runs to its end exits with 95.
 */
import { existsSync, readFileSync, writeSync } from 'node:fs'
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
} else if (spec.mode === 'race') {
  // With `holdFile`, the writer stops inside its write transaction (after BEGIN IMMEDIATE), prints `holding`, and
  // goes on once that file exists (bounded wait), so a competing writer meets a held SQLite write lock.
  const hold = (name) => {
    if (name !== 'begun' || !spec.holdFile) return
    writeSync(1, 'holding\n')
    const deadline = Date.now() + 30_000
    while (!existsSync(spec.holdFile) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)
  }
  const handle = openStore(spec.file, { privatePaths: { root: spec.root }, now: () => spec.now, unsafeTestPhase: hold })
  writeSync(1, 'ready\n')
  await new Promise((resolve) => process.stdin.once('data', resolve))
  let result
  try {
    result = { status: (await handle.commit(spec.request)).status }
  } catch (error) {
    result = { code: error.code, outcome: error.outcome }
  }
  writeSync(1, `result:${JSON.stringify(result)}\n`)
  await handle.close()
  process.exit(0)
} else {
  const handle = openStore(spec.file, {
    privatePaths: { root: spec.root },
    now: () => spec.now,
    unsafeTestPhase: (name) => { if (name === spec.phase) pause(name) },
  })
  const commit = (leaseToken) => handle.commit(spec.request, leaseToken === undefined ? undefined : { leaseToken })
  const result = spec.lease ? await withLibraryOperation({ root: spec.root }, (leaseToken) => commit(leaseToken)) : await commit()
  writeSync(1, `result:${result.status}\n`)
  await handle.close()
  process.exitCode = 95
}
