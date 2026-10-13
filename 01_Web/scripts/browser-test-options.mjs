/**
 * Command-line options of `npm run test:browser` (`run-browser-tests.mjs`). Pure, so each rule has a unit test.
 *
 * - At most one group flag. Without one, every `*.spec.mjs` case runs.
 * - At most one `--shard=<current>/<total>`, alone or with a group. It is passed to Playwright unchanged; which cases
 *   a shard receives is Playwright's decision (see the group's spec files for how they are grouped).
 * - Anything else is refused, so a mistyped flag never silently widens or narrows a run.
 */

// Playwright arguments for each group, after `test --config playwright.config.mjs`.
const GROUP_ARGS = Object.freeze({
  '--performance': Object.freeze([]),
  '--time-filters': Object.freeze(['time-filter']),
  '--critical-flows': Object.freeze(['critical-flows.spec.mjs']),
  '--media-recovery': Object.freeze(['media-recovery.spec.mjs']),
  '--media-lifecycle': Object.freeze(['media-recovery.spec.mjs', '--grep', 'lost responses, storage loss']),
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
