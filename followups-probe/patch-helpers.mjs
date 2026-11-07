// Temporary (test stability, round 1; reused by the follow-ups): adds the probe's hooks to tests/browser/helpers.mjs in the runner's checkout only
// (the stability-probe workflow runs it after restoring any older file it compares with). Nothing is committed.
// - STARMAP_PROBE_INIT (+ STARMAP_PROBE_PARAMS): the init script ./probe-init.js on every fixture page.
// - STARMAP_PROBE_OUT: per case, a JSON file with the probe's page records, the render loop state, the editor write
//   requests as Node saw them (when Playwright reported each, against the page's own start time) and the annotations.
// Usage: node followups-probe/patch-helpers.mjs <path of helpers.mjs>
import { readFileSync, writeFileSync } from 'node:fs'

const file = process.argv[2]
let source = readFileSync(file, 'utf8').split('\r\n').join('\n')
const patches = [
  [
    "    await page.addInitScript(() => localStorage.setItem('starmap.uiLocale', 'en'))\n",
    `    await page.addInitScript(() => localStorage.setItem('starmap.uiLocale', 'en'))
    // stability probe (temporary)
    const probeRequests = []
    if (process.env.STARMAP_PROBE_INIT) {
      const { readFileSync: readProbe } = await import('node:fs')
      await page.addInitScript({ content: \`window.__stabilityProbeParams = \${process.env.STARMAP_PROBE_PARAMS || '{}'};\\n\` + readProbe(process.env.STARMAP_PROBE_INIT, 'utf8') })
    }
    if (process.env.STARMAP_PROBE_OUT) {
      const editor = (request) => request.method() !== 'GET' && new URL(request.url()).pathname.startsWith('/__travelatlas/editor/')
      page.on('request', (request) => {
        if (!editor(request)) return
        probeRequests.push({ path: new URL(request.url()).pathname, method: request.method(), nodeAt: Date.now() })
      })
      page.on('requestfinished', (request) => {
        if (!editor(request)) return
        const entry = probeRequests.findLast((item) => item.path === new URL(request.url()).pathname && item.finishedAt === undefined)
        // The page's own start time of the request is known once it is answered (timing().startTime is 0 before).
        if (entry) { entry.finishedAt = Date.now(); entry.timing = request.timing(); entry.reportedAfterMs = entry.timing.startTime > 0 ? entry.nodeAt - entry.timing.startTime : null }
      })
    }
`,
  ],
  [
    "      mediaPhase(media, 'fixture context close started', { status: testInfo.status })\n",
    `      if (process.env.STARMAP_PROBE_OUT) {
        try {
          const read = page.evaluate(() => ({ probe: window.__stabilityProbe, loop: window.__travelAtlasDebugRenderLoop?.state(), now: performance.now() }))
          const data = await Promise.race([read, new Promise((resolve) => setTimeout(() => resolve({ unavailable: '3 s deadline' }), 3000))]).catch((error) => ({ unavailable: String(error?.message ?? error) }))
          const { mkdirSync, writeFileSync: writeProbe } = await import('node:fs')
          mkdirSync(process.env.STARMAP_PROBE_OUT, { recursive: true })
          const name = \`\${path.basename(testInfo.file)}-\${testInfo.title.replace(/[^a-z0-9]+/gi, '-').slice(0, 60)}-r\${testInfo.repeatEachIndex}.json\`
          writeProbe(path.join(process.env.STARMAP_PROBE_OUT, name), JSON.stringify({ file: path.basename(testInfo.file), title: testInfo.title, repeat: testInfo.repeatEachIndex,
            status: testInfo.status, durationMs: testInfo.duration, errors: testInfo.errors.map((error) => String(error.message ?? '').slice(0, 2000)),
            annotations: testInfo.annotations, requests: probeRequests, page: data }, null, 1))
        } catch (error) { console.warn('stability probe: no record', String(error?.message ?? error)) }
      }
      mediaPhase(media, 'fixture context close started', { status: testInfo.status })
`,
  ],
]
for (const [anchor, replacement] of patches) {
  if (source.split(anchor).length !== 2) throw new Error(`patch-helpers: anchor not found exactly once: ${anchor.trim()}`)
  source = source.replace(anchor, replacement)
}
writeFileSync(file, source)
console.log(`stability probe hooks added to ${file}`)
