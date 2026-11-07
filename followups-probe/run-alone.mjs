// Temporary (test stability follow-ups, round 2, G2; design §2.1, §10.5): runs each case of the given spec files alone,
// one Playwright run per case (run.mjs: its own synthetic fixture, dev server and browser), so that no case can lean on
// what an earlier one left. The cases are listed with --list and dealt out to the shards in turn.
// Writes STARMAP_PROBE_OUT/alone-<index>of<total>.json (each case: file:line, title, exit code, seconds); exits 1 when
// a case failed.
// Usage (from 01_Web): node ../followups-probe/run-alone.mjs <index>/<total> <spec files>...
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const [shard, ...files] = process.argv.slice(2)
const [index, total] = shard.split('/').map(Number)
if (!(index >= 1 && index <= total) || !files.length) throw new Error('Usage: run-alone.mjs <index>/<total> <spec files>...')
const runner = path.join(path.dirname(fileURLToPath(import.meta.url)), 'run.mjs')
const NL = String.fromCharCode(10)

const listed = spawnSync(process.execPath, [runner, '--', '--list', ...files], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
if (listed.status !== 0) { process.stdout.write(listed.stdout ?? ''); process.stderr.write(listed.stderr ?? ''); throw new Error('Listing the cases failed') }
const seen = new Set()
const cases = []
for (const line of listed.stdout.split(NL)) {
  const match = /([\w.-]+\.spec\.mjs):(\d+):\d+ › (.*)$/.exec(line)
  if (!match) continue
  const key = match[1] + ':' + match[2]
  if (seen.has(key)) continue
  seen.add(key)
  cases.push({ file: match[1], line: Number(match[2]), title: match[3].trim() })
}
if (!cases.length) throw new Error('No case listed')
const mine = cases.filter((_, position) => position % total === index - 1)
console.log('followups probe: ' + cases.length + ' cases listed, ' + mine.length + ' in shard ' + shard)

const portFree = () => new Promise((resolve) => {
  const socket = net.connect({ host: '127.0.0.1', port: 5173 })
  socket.on('connect', () => { socket.destroy(); resolve(false) })
  socket.on('error', () => resolve(true))
})
const results = []
for (const item of mine) {
  for (let waited = 0; !(await portFree()) && waited < 60; waited++) await new Promise((resolve) => setTimeout(resolve, 500))
  const target = 'tests/browser/' + item.file + ':' + item.line
  console.log(NL + 'followups probe: alone ' + target + ' › ' + item.title)
  const started = Date.now()
  const run = spawnSync(process.execPath, [runner, '--', target], { stdio: 'inherit' })
  results.push({ ...item, status: run.status, seconds: Math.round((Date.now() - started) / 100) / 10 })
}
const out = process.env.STARMAP_PROBE_OUT
if (out) {
  mkdirSync(out, { recursive: true })
  writeFileSync(path.join(out, 'alone-' + index + 'of' + total + '.json'), JSON.stringify({ shard, listed: cases.length, results }, null, 1))
}
const failed = results.filter((result) => result.status !== 0)
console.log(NL + 'followups probe: ' + (results.length - failed.length) + '/' + results.length + ' passed alone' + (failed.length ? '; failed: ' + failed.map((result) => result.file + ':' + result.line).join(', ') : ''))
process.exitCode = failed.length ? 1 : 0
