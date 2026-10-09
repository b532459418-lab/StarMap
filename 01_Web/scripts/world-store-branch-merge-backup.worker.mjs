/** Finite synthetic backup termination worker. Scope checked before input IO. */
import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRepositoryMergeBackupHost, backupRepositoryMergeStore } from './world-store-branch-merge-backup.mjs'

const file = process.argv[2]
if (typeof file !== 'string' || !path.isAbsolute(file) || path.normalize(file) !== file
  || !path.basename(file).startsWith('worker-')) throw new Error('Invalid synthetic worker scope')
const lab = path.dirname(file)
if (path.dirname(lab) !== realpathSync(tmpdir()) || !path.basename(lab).startsWith('starmap-merge-store-')) throw new Error('Invalid synthetic worker scope')
const labStat = lstatSync(lab)
if (!labStat.isDirectory() || labStat.isSymbolicLink() || realpathSync(lab) !== lab) throw new Error('Invalid synthetic worker scope')
const identity = stat => `${stat.dev}:${stat.ino}`
const labIdentity = identity(lstatSync(lab, { bigint: true })), stat = lstatSync(file, { bigint: true })
if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.size <= 0n || stat.size > 128n * 1024n * 1024n) throw new Error('Invalid synthetic worker spec')
let buffer
const fd = openSync(file, 'r')
try {
  const opened = fstatSync(fd, { bigint: true })
  if (identity(opened) !== identity(stat) || opened.size !== stat.size || opened.nlink !== 1n) throw new Error('Invalid synthetic worker spec')
  buffer = Buffer.alloc(Number(opened.size))
  let offset = 0
  while (offset < buffer.length) {
    const count = readSync(fd, buffer, offset, buffer.length - offset, offset)
    if (!count) throw new Error('Invalid synthetic worker spec')
    offset += count
  }
  const ended = fstatSync(fd, { bigint: true })
  if (readSync(fd, Buffer.alloc(1), 0, 1, offset) || ended.size !== opened.size || ended.nlink !== 1n
    || identity(lstatSync(file, { bigint: true })) !== identity(opened)) throw new Error('Invalid synthetic worker spec')
} finally { closeSync(fd) }
if (identity(lstatSync(lab, { bigint: true })) !== labIdentity || realpathSync(lab) !== lab) throw new Error('Invalid synthetic worker scope')
const spec = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer))
if (spec.sandboxRoot !== lab) throw new Error('Invalid synthetic worker scope')
const host = createRepositoryMergeBackupHost({ sandboxRoot: lab, hostId: 'synthetic-host', authorize: () => true })
try {
  backupRepositoryMergeStore(spec.source, spec.target, spec.preview, spec.operationId, { host, unsafeTestPhase(name) {
    if (name === spec.phase) {
      writeSync(1, 'paused:' + name + '\n')
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20000)
      throw new Error('Synthetic worker was not terminated in time')
    }
  } })
} catch (error) {
  writeSync(2, JSON.stringify({ code: error.code ?? error.message }) + '\n')
  process.exitCode = 2
}
