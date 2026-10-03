import net from 'node:net'
import { createBackup, inspectBackup, restoreBackup } from './library-backup.mjs'

const usage = 'npm run backup -- create --root <private-root> --out <new-backup-directory>\nnpm run backup -- inspect --from <backup-directory>\nnpm run backup -- restore --from <backup-directory> --to <new-private-root> [--apply]'
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
} catch (error) {
  // Never expose JSON excerpts, original filenames, locations or user paths.
  console.error(/^E_BACKUP_[A-Z_]+$/.test(error.message) ? error.message : 'E_BACKUP_IO')
  console.error('Existing library is unchanged. A failed operation may leave a new incomplete directory; it is not activated.')
  if (error.message === 'E_BACKUP_USAGE') console.error(usage)
  process.exitCode = 1
}
