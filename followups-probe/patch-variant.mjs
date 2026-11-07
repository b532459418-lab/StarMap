// Temporary (test stability follow-ups, round 2; design §10.6): variants patched into the runner's checkout only (run
// from 01_Web). Nothing is committed. Each variant fails loudly when its anchor is not found as expected.
//   mutation       the save path's pauseRendering is a no-op (src/data/localEditorApi.ts)
//   mutation-loop  a pause no longer turns the globe's loop off (src/data/renderPause.ts bindRenderLoop)
//   f5-off         G3 control: the evidence screenshot does not wait for the page to keep up (F5-1 off)
//   g3-trigger     G3: the evidence screenshot starts the probe's GPU load (probe-init.js gpuLoad) first, and logs the
//                  probe's GPU batches and frame intervals right after the capture (the time-filter afterEach closes
//                  the page before the fixture's own record)
//   g1-blank       G1: before the page fixture closes its context, its pages go to about:blank (the renderer lets go of
//                  its WebGL contexts first); run after patch-teardown.mjs, whose records it adds to
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
  'f5-off'() {
    edit('tests/browser/helpers.mjs', [['  const keptUp = await pageKeepsUp(page)' + NL,
      '  const keptUp = { keptUp: null, waitedMs: 0, skipped: \'probe variant f5-off\' }' + NL, 'f5-off']])
  },
  'g3-trigger'() {
    edit('tests/browser/helpers.mjs', [
      ['export async function screenshotWithObservations(page, testInfo, options) {' + NL,
        'export async function screenshotWithObservations(page, testInfo, options) {' + NL
        + '  const probeGpu = await page.evaluate(() => window.__stabilityProbeGpuLoad?.() ?? null).catch((error) => ({ error: String(error?.message ?? error) }))' + NL
        + '  console.info(\'followups probe GPU load\', JSON.stringify(probeGpu))' + NL, 'g3-trigger start'],
      ["  } finally {" + NL + "    await finishSchedulerTrace(page, testInfo, { retain: failed, name: 'screenshot-scheduler', label: 'Screenshot scheduler trace' })" + NL,
        '  } finally {' + NL
        + '    const probeAfter = await page.evaluate(() => { const probe = window.__stabilityProbe; return probe && { gpu: probe.gpu, raf: probe.raf.slice(-300), longTasks: probe.longTasks, now: Math.round(performance.now()) } }).catch((error) => ({ error: String(error?.message ?? error) }))' + NL
        + '    console.info(\'followups probe GPU after\', JSON.stringify(probeAfter))' + NL
        + "    await finishSchedulerTrace(page, testInfo, { retain: failed, name: 'screenshot-scheduler', label: 'Screenshot scheduler trace' })" + NL, 'g3-trigger after'],
    ])
  },
  'g1-blank'() {
    edit('tests/browser/helpers.mjs', [['      const probeContextAt = performance.now()' + NL,
      '      const probeBlankAt = performance.now()' + NL
      + '      for (const open of context.pages()) await open.goto(\'about:blank\', { timeout: 5000 }).catch(() => {})' + NL
      + '      await probeTeardown(testInfo, { phase: \'pages to about:blank\', ms: Math.round(performance.now() - probeBlankAt) })' + NL
      + '      const probeContextAt = performance.now()' + NL, 'g1-blank']])
  },
}
for (const name of process.argv.slice(2)) {
  if (!variants[name]) throw new Error('patch-variant: unknown variant ' + name)
  variants[name]()
  console.log('followups probe variant ' + name + ' applied')
}
