import { existsSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { createBackup, inspectBackup, restoreBackup } from './library-backup.mjs'
import { privateDataSource } from './private-data-source.mjs'
import { getPrivatePaths } from './private-profile.mjs'

const usage = 'npm run backup -- create --root <private-root> --out <new-backup-directory>\nnpm run backup -- inspect --from <backup-directory>\nnpm run backup -- restore --from <backup-directory> --to <new-private-root> [--apply]'
// 3C-4b: a private root in the new-library mode (data/store/world.sqlite exists) is backed up by store:backup's
// implementation (the database snapshot and the media); the V2 backup below would miss the store. V2 roots: unchanged.
const STORE_NOTE = 'New-library mode (data/store/world.sqlite): backed up with the implementation of npm run store:backup (database snapshot and media). Restore with npm run store:restore -- --from <backup-directory> --to <new-private-root>.'

/** `create` on a new-library root: store:backup's backupStore. Its refusals print their code and safe problem lines. */
async function storeBackup(root, out) {
  const { backupStore } = await import('./store-backup.mjs')
  try {
    const { manifest } = await backupStore(getPrivatePaths({ STARMAP_PRIVATE_ROOT: root }), { out })
    console.log(JSON.stringify({
      ok: true, status: 'backup-created', mode: 'store', delegatedTo: 'store:backup', note: STORE_NOTE,
      revision: manifest.store.revision, mediaFiles: manifest.media.count, mediaBytes: manifest.media.bytes, warnings: manifest.media.warnings,
    }, null, 2))
  } catch (error) {
    console.error(STORE_NOTE)
    console.error(typeof error?.code === 'string' && /^E_[A-Z0-9_]+$/.test(error.code) ? error.code : 'E_BACKUP_IO')
    for (const problem of error?.problems ?? []) console.error(`  - ${problem}`)
    console.error('Existing library is unchanged. No new backup directory was left behind.')
    process.exitCode = 1
  }
}

try {
  const [mode, ...argv] = process.argv.slice(2)
  const options = {}
  const supported = mode === 'create' ? ['root', 'out'] : mode === 'inspect' ? ['from'] : mode === 'restore' ? ['from', 'to', 'apply'] : []
  if (!supported.length) throw new Error('E_BACKUP_USAGE')
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index].slice(2)
    if (!argv[index].startsWith('--') || !supported.includes(name) || options[name] !== undefined) throw new Error('E_BACKUP_USAGE')
    if (name === 'apply') options.apply = true
    else {
      const value = argv[++index]
      if (!value || value.startsWith('--')) throw new Error('E_BACKUP_USAGE')
      options[name] = value
    }
  }
  if (supported.some(name => name !== 'apply' && !options[name])) throw new Error('E_BACKUP_USAGE')
  if (mode === 'create' && privateDataSource(getPrivatePaths({ STARMAP_PRIVATE_ROOT: options.root })) === 'store') {
    await storeBackup(options.root, options.out)
  } else {
    // A backup made by store:backup has a completion mark; this tool reads V2 backups only.
    if (mode !== 'create' && existsSync(path.join(options.from, 'COMPLETE.json'))) throw new Error('E_BACKUP_STORE_FORMAT')
    if (mode === 'create') {
      // Offline precondition: never stop or reuse another process's preview.
      for (const port of [5173, 5174]) {
        const occupied = await new Promise((resolve, reject) => {
          const socket = net.connect({ host: '127.0.0.1', port })
          socket.setTimeout(2000)
          socket.on('connect', () => { socket.destroy(); resolve(true) })
          socket.on('error', error => error.code === 'ECONNREFUSED' ? resolve(false) : reject(new Error('E_BACKUP_PORT_PROBE')))
          socket.on('timeout', () => { socket.destroy(); reject(new Error('E_BACKUP_PORT_PROBE')) })
        })
        if (occupied) throw new Error('E_BACKUP_PREVIEW_ACTIVE')
      }
    }
    const result = mode === 'create' ? await createBackup(options.root, options.out) : mode === 'inspect' ? (await inspectBackup(options.from)).summary : await restoreBackup(options.from, options.to, { apply: options.apply })
    console.log(JSON.stringify({ ok: true, ...result }, null, 2))
  }
} catch (error) {
  // Never expose JSON excerpts, original filenames, locations or user paths.
  console.error(/^E_BACKUP_[A-Z_]+$/.test(error.message) ? error.message : 'E_BACKUP_IO')
  if (error.message === 'E_BACKUP_STORE_FORMAT') console.error('This is a new-library backup (npm run store:backup). Restore it with npm run store:restore -- --from <backup-directory> --to <new-private-root>.')
  console.error('Existing library is unchanged. A failed operation may leave a new incomplete directory; it is not activated.')
  if (error.message === 'E_BACKUP_USAGE') console.error(usage)
  process.exitCode = 1
}
