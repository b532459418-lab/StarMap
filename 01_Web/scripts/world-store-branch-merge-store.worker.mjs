/** Bounded synthetic crash/concurrency worker. No private discovery/services. */
import { lstatSync, readFileSync, writeSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRepositoryMergeStoreHost, openRepositoryMergeStore, createRepositoryMergeStore,
  recoverRepositoryMergeStore } from './world-store-branch-merge-store.mjs'

const specFile = process.argv[2]
if (typeof specFile !== 'string' || !path.isAbsolute(specFile) || path.normalize(specFile) !== specFile
  || !path.basename(specFile).startsWith('worker-')) throw new Error('Invalid synthetic worker scope')
const lab = path.dirname(specFile)
if (path.dirname(lab) !== realpathSync(tmpdir()) || !path.basename(lab).startsWith('starmap-merge-store-')) throw new Error('Invalid synthetic worker scope')
const labStat = lstatSync(lab)
if (!labStat.isDirectory() || labStat.isSymbolicLink() || realpathSync(lab) !== lab) throw new Error('Invalid synthetic worker scope')
const stat = lstatSync(specFile)
if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 128 * 1024 * 1024) throw new Error('Invalid synthetic worker spec')
const spec = JSON.parse(readFileSync(specFile, 'utf8'))
if (lab !== spec.sandboxRoot) throw new Error('Invalid synthetic worker scope')
const host = createRepositoryMergeStoreHost({ sandboxRoot: spec.sandboxRoot, hostId: 'synthetic-host', authorize: () => true })
const options = { host, unsafeTestPhase(name) {
  if (name === spec.phase) {
    writeSync(1, 'paused:' + name + '\n')
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20000)
    throw new Error('Synthetic worker was not terminated in time')
  }
} }
let store
try {
  if (spec.kind === 'create') createRepositoryMergeStore(spec.source, spec.target, spec.preview, spec.operationId, options)
  else {
    recoverRepositoryMergeStore(spec.target, { host })
    store = openRepositoryMergeStore(spec.target, options)
    store.apply(spec.request, spec.source ? { source: spec.source } : {})
  }
  process.exitCode = 3
} catch (error) {
  writeSync(2, JSON.stringify({ code: error.code ?? error.message }) + '\n')
  process.exitCode = 2
} finally { store?.close() }
