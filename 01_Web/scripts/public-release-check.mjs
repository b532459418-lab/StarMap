import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { sourceRoot } from './private-profile.mjs'

const execFileAsync = promisify(execFile)
const npmExecPath = process.env.npm_execpath

/**
 * The environment variables the clean-room commands (git, tar, npm ci, lint, test, build) inherit; everything else is
 * dropped (batch 7, review S5). Gone are in particular `STARMAP_PRIVATE_ROOT` and every other `STARMAP_*` value,
 * `VITE_*` values (a build would bake provider keys into the bundle), tokens (`GITHUB_TOKEN`, `NPM_TOKEN`,
 * `npm_config_*` including auth settings) and `NODE_OPTIONS`. Kept: the search path and what Windows and POSIX
 * programs need to start, home and temporary directories (npm's cache and config), locale and time zone, `CI`, and the
 * proxy and certificate settings npm ci needs to reach the registry.
 */
const KEPT_NAMES = new Set([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'OS', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS',
  'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432', 'COMMONPROGRAMFILES', 'COMMONPROGRAMFILES(X86)',
  'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'TMPDIR',
  'LANG', 'LANGUAGE', 'TZ', 'TERM', 'CI',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'NODE_USE_ENV_PROXY', 'NODE_USE_SYSTEM_CA', 'NODE_EXTRA_CA_CERTS',
])

/** The sanitized copy of `source` (names compared case-insensitively, as Windows does; original spelling kept). */
export function releaseCheckEnvironment(source = process.env) {
  const kept = {}
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue
    const upper = name.toUpperCase()
    if (KEPT_NAMES.has(upper) || upper.startsWith('LC_')) kept[name] = value
  }
  return kept
}

const writeToProcess = (stream, text) => process[stream].write(text)

/**
 * Runs one command with the sanitized environment and prints what it wrote. When it fails, the output captured so far
 * is printed before the error (it used to be dropped, so a failing step showed only its exit code).
 */
export async function run(command, args, cwd, { env = releaseCheckEnvironment(), write = writeToProcess } = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, { cwd, env, maxBuffer: 16 * 1024 * 1024 })
    if (stdout) write('stdout', stdout)
    if (stderr) write('stderr', stderr)
  } catch (error) {
    if (error?.stdout) write('stdout', String(error.stdout))
    if (error?.stderr) write('stderr', String(error.stderr))
    throw new Error(`Failed to run ${command} ${args.join(' ')}: ${error.message}`, { cause: error })
  }
}

async function runNpm(args, cwd) {
  if (npmExecPath) return run(process.execPath, [npmExecPath, ...args], cwd)
  return run(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, cwd)
}

async function main() {
  const { stdout: status } = await execFileAsync('git', ['status', '--porcelain'], { cwd: sourceRoot, env: releaseCheckEnvironment() })
  if (status.trim()) {
    throw new Error('公共发布检查要求 01_source 工作区完全干净。请先检查并提交本地修改。')
  }

  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'starmap-public-release-'))
  const archivePath = path.join(temporaryRoot, 'source.tar')
  const checkoutRoot = path.join(temporaryRoot, 'checkout')
  const checkoutWebRoot = path.join(checkoutRoot, '01_Web')

  try {
    await mkdir(checkoutRoot, { recursive: true })
    await run('git', ['archive', '--format=tar', 'HEAD', '-o', archivePath], sourceRoot)
    await run('tar', ['-xf', archivePath, '-C', checkoutRoot], sourceRoot)
    await runNpm(['ci', '--no-audit', '--no-fund'], checkoutWebRoot)
    await runNpm(['run', 'lint'], checkoutWebRoot)
    await runNpm(['test'], checkoutWebRoot)
    await runNpm(['run', 'build:public'], checkoutWebRoot)
    console.log('StarMap clean-room public release check passed.')
    console.log('The lint, test and build used only files tracked by Git and a sanitized environment; 06_private was not available to them.')
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
