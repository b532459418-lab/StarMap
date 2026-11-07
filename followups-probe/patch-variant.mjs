// Temporary (test stability follow-ups, round 1; design §1.3, §3, §5, §6): variants patched into the runner's checkout
// only (run from 01_Web). Nothing is committed. Each variant fails loudly when its anchor is not found as expected.
//   mutation          the save path's pauseRendering is a no-op (src/data/localEditorApi.ts)
//   mutation-loop     a pause no longer turns the globe's loop off (src/data/renderPause.ts bindRenderLoop)
//   g5-hold           G5: the refused-save case's three answers come 600 ms after the save's click (holdWrite ms), and
//                     each pause must have lasted over 500 ms, next to its check of the recorded frames
//   f5-off            G3 control: the evidence screenshot does not wait for the page to keep up (F5-1 off)
//   g3-trigger        G3: the evidence screenshot starts the probe's GPU load (probe-init.js gpuLoad) first
//   g6-fix            G6: the first WebGL probe belongs to one mount of the globe (forgotten when it unmounts)
//   g1-trace-noshots  G1: the retained-on-failure trace without screenshots (actions, snapshots and network stay)
//   g1-no-cache       G1: the browser without its HTTP disk cache and GPU shader disk cache
// Usage: node ../followups-probe/patch-variant.mjs <variant>...
import { readFileSync, writeFileSync } from 'node:fs'

const NL = String.fromCharCode(10)
const read = (file) => readFileSync(file, 'utf8').split(String.fromCharCode(13) + NL).join(NL)
const replace = (source, from, to, what, count = 1) => {
  const found = source.split(from).length - 1
  if (found !== count) throw new Error('patch-variant ' + what + ': anchor found ' + found + ' times, expected ' + count + ': ' + from.slice(0, 90))
  return source.split(from).join(to)
}
const edit = (file, changes) => {
  let source = read(file)
  for (const [from, to, what, count] of changes) source = replace(source, from, to, what, count)
  writeFileSync(file, source)
}

const variants = {
  mutation() {
    edit('src/data/localEditorApi.ts', [['  const resume = pauseRendering()' + NL,
      '  const resume = (() => () => undefined)() // probe mutation: no pause on the save path' + NL, 'mutation']])
  },
  'mutation-loop'() {
    edit('src/data/renderPause.ts', [['      target.useDefaultRenderLoop = false' + NL,
      '      // probe mutation: the loop is not turned off' + NL, 'mutation-loop']])
  },
  'g5-hold'() {
    const check = (endedBy) => "{ const state = await expectRendering(page, '" + endedBy + "'); expectNoFrameWhilePaused(state, started); expect(state.episodes.at(-1).pausedMs).toBeGreaterThan(500) }"
    edit('tests/browser/critical-flows.spec.mjs', [
      ['await holdWrite(page, { fulfil: ', 'await holdWrite(page, { ms: 600, fulfil: ', 'g5-hold holdWrite', 3],
      ["expectNoFrameWhilePaused(await expectRendering(page, 'failed'), started)", check('failed'), 'g5-hold failed', 2],
      ["expectNoFrameWhilePaused(await expectRendering(page, 'released'), started)", check('released'), 'g5-hold released'],
    ])
  },
  'f5-off'() {
    edit('tests/browser/helpers.mjs', [['  const keptUp = await pageKeepsUp(page)' + NL,
      '  const keptUp = { keptUp: null, waitedMs: 0, skipped: \'probe variant f5-off\' }' + NL, 'f5-off']])
  },
  'g3-trigger'() {
    edit('tests/browser/helpers.mjs', [['export async function screenshotWithObservations(page, testInfo, options) {' + NL,
      'export async function screenshotWithObservations(page, testInfo, options) {' + NL
      + '  const probeGpu = await page.evaluate(() => window.__stabilityProbeGpuLoad?.() ?? null).catch((error) => ({ error: String(error?.message ?? error) }))' + NL
      + '  console.info(\'followups probe GPU load\', JSON.stringify(probeGpu))' + NL, 'g3-trigger']])
  },
  'g6-fix'() {
    edit('src/data/webglSupport.ts', [['/** Tests: forget the first probe. */' + NL,
      '/** Forget the first probe: the next viewer of a new mount probes again (probe variant g6-fix). */' + NL
      + 'export function forgetFirstWebGLProbe(): void {' + NL + '  first = undefined' + NL + '}' + NL + NL
      + '/** Tests: forget the first probe. */' + NL, 'g6-fix webglSupport']])
    edit('src/components/CesiumAtlasGlobe.tsx', [
      ["import { browserWebGLEnvironment, firstWebGLProbe, probeWebGL } from '../data/webglSupport'" + NL,
        "import { browserWebGLEnvironment, firstWebGLProbe, forgetFirstWebGLProbe, probeWebGL } from '../data/webglSupport'" + NL, 'g6-fix import'],
      ["  const [webgl, setWebgl] = useState<'available' | 'unavailable'>(() => firstWebGLProbe() ? 'available' : 'unavailable')" + NL,
        "  const [webgl, setWebgl] = useState<'available' | 'unavailable'>(() => firstWebGLProbe() ? 'available' : 'unavailable')" + NL
        + '  // probe variant g6-fix: the first probe belongs to this mount (a later mount, after an error boundary, probes again).' + NL
        + '  useEffect(() => () => forgetFirstWebGLProbe(), [])' + NL, 'g6-fix effect'],
    ])
  },
  'g1-trace-noshots'() {
    edit('playwright.config.mjs', [["    trace: performance ? 'off' : 'retain-on-failure'," + NL,
      "    trace: performance ? 'off' : { mode: 'retain-on-failure', screenshots: false }," + NL, 'g1-trace-noshots']])
  },
  'g1-no-cache'() {
    edit('playwright.config.mjs', [["    launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] }," + NL,
      "    launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disk-cache-size=1', '--disable-gpu-shader-disk-cache'] }," + NL, 'g1-no-cache']])
  },
}
for (const name of process.argv.slice(2)) {
  if (!variants[name]) throw new Error('patch-variant: unknown variant ' + name)
  variants[name]()
  console.log('followups probe variant ' + name + ' applied')
}
