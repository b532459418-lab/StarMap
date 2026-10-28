/**
 * Command-line options of `npm run test:browser` (`run-browser-tests.mjs`). Pure, so each rule has a unit test.
 *
 * - At most one group flag. Without one, every `*.spec.mjs` case runs.
 * - At most one `--shard=<current>/<total>`, alone or with a group. It is passed to Playwright unchanged; which cases
 *   a shard receives is Playwright's decision (see the group's spec files for how they are grouped).
 * - Anything else is refused, so a mistyped flag never silently widens or narrows a run.
 * - A shard that receives no case fails (batch 4B). Playwright itself reports such a shard as a pass, so the runner
 *   first lists the shard's cases with `listingArgs` and checks the listing with `assertShardListed`.
 */

// Playwright arguments for each group, after `test --config playwright.config.mjs`.
const GROUP_ARGS = Object.freeze({
  '--performance': Object.freeze([]),
  '--time-filters': Object.freeze(['time-filter']),
  // The globe's recovery after a failure (map-recovery.spec.mjs) runs with the critical flows.
  '--critical-flows': Object.freeze(['critical-flows.spec.mjs', 'map-recovery.spec.mjs']),
  '--media-recovery': Object.freeze(['media-recovery.spec.mjs']),
  '--media-lifecycle': Object.freeze(['media-recovery.spec.mjs', '--grep', 'lost responses, storage loss']),
  // The built public bundle through `vite preview`; the config then matches only *.smoke.mjs.
  '--public-smoke': Object.freeze([]),
  // 3C-4d: a root that needs migrating, migrated while the dev server runs; the config then matches only *.migration.mjs.
  '--migration': Object.freeze([]),
})

export const BROWSER_TEST_GROUPS = Object.freeze(Object.keys(GROUP_ARGS))

const SHARD = /^--shard=([1-9]\d*)\/([1-9]\d*)$/
const USAGE = `Supported options: one of ${BROWSER_TEST_GROUPS.join(', ')}, optionally with --shard=<current>/<total> (for example --shard=2/3)`

/**
 * @param {readonly string[]} args the runner's own arguments (`process.argv.slice(2)`)
 * @returns {{ group: string | null, shard: string | null, playwrightArgs: string[] }}
 */
export function parseBrowserTestArgs(args) {
  let group = null
  let shard = null
  for (const arg of args) {
    if (Object.hasOwn(GROUP_ARGS, arg)) {
      if (group !== null) throw new Error(`Only one group can run at a time (${group} and ${arg}). ${USAGE}`)
      group = arg
    } else if (arg.startsWith('--shard')) {
      const match = SHARD.exec(arg)
      if (!match || Number(match[1]) > Number(match[2])) throw new Error(`Invalid shard "${arg}": use --shard=<current>/<total> with 1 <= current <= total. ${USAGE}`)
      if (shard !== null) throw new Error(`Only one --shard can be given (${shard} and ${arg}). ${USAGE}`)
      shard = arg
    } else {
      throw new Error(`Unknown option "${arg}". ${USAGE}`)
    }
  }
  return { group, shard, playwrightArgs: [...(group ? GROUP_ARGS[group] : []), ...(shard ? [shard] : [])] }
}

/**
 * Playwright arguments that only list the cases the same run would execute: the identical selection, plus `--list`
 * and the plain list reporter (which, in list mode, prints the names and one summary line and writes no report).
 * @param {readonly string[]} playwrightArgs from `parseBrowserTestArgs`
 */
export function listingArgs(playwrightArgs) {
  return ['--list', '--reporter=list', ...playwrightArgs]
}

const LISTED_TOTAL = /^Total: (\d+) tests? in \d+ files?\r?$/gm

/**
 * The number of cases in a `listingArgs` listing. Fails closed: output without exactly one summary line is an error,
 * never "no cases".
 * @param {string} output standard output of `playwright test` with `listingArgs`
 */
export function listedTestCount(output) {
  const totals = [...String(output).matchAll(LISTED_TOTAL)]
  if (totals.length !== 1) throw new Error(`Expected one "Total: <n> tests in <m> files" line in the Playwright listing, found ${totals.length}.`)
  return Number(totals[0][1])
}

/**
 * Refuses a shard whose listing has no case; otherwise returns the number of listed cases.
 * @param {string} shard the `--shard=<i>/<n>` argument
 * @param {string} output standard output of `playwright test` with `listingArgs`
 */
export function assertShardListed(shard, output) {
  const count = listedTestCount(output)
  if (count === 0) throw new Error(`${shard} received no test cases. Use fewer shards for this group: an empty shard would pass without running anything.`)
  return count
}
