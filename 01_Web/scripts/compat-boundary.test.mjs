/**
 * The compat boundary (3C-5 E spec §2.4). What reads and writes V2 files is kept in two compat directories,
 * `src/data/compat/` and `scripts/compat/`: reading V2 files, the migration, the read-only display of a root that awaits
 * migration, and the export to V2. Ordinary read and write code does not import them: the App's code under `src/` never
 * does, and a script does only when it is listed below, with the reason. A new import of a compat module from ordinary
 * code fails here; so does a listed script that no longer imports one (the list stays exact).
 *
 * Ordinary code: every module under `src/` and `scripts/` and `vite.config.ts`, except tests (`*.test.*`), test fixtures
 * (`*.fixture.*`) and the compat directories themselves. Imports: static and dynamic `import`, and `export … from`.
 */
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const COMPAT_DIRECTORIES = Object.freeze(['src/data/compat', 'scripts/compat'])

/** The scripts that may import the compat directories, and why. Each must still import one. */
const ALLOWED = Object.freeze({
  'scripts/baseline.mjs': 'the derived baseline of a root that awaits migration or of the V2 sample, through the in-memory migration',
  'scripts/browser-fixture.mjs': 'browser-test support: its fixture libraries are V2 files migrated into the store',
  'scripts/import-media.mjs': 'media:check on a root that awaits migration: the read-only V2 preview',
  'scripts/library-backup.mjs': '`npm run backup` of a root that holds V2 files checks their integrity',
  'scripts/local-editor-plugin.mjs': 'the read-only display of a root that awaits migration (its V2 files migrated in memory)',
  'scripts/privacy-audit.mjs': 'the privacy audit of the V2 sample (src/data/v2-sample/)',
  'scripts/store-media-bench.mjs': 'a benchmark: its libraries are generated V2 roots, migrated',
  'scripts/store-mode-bench.mjs': 'a benchmark: its libraries are generated V2 roots, migrated, and it times the V2 path',
  'scripts/store-recover.mjs': 'the recovery check of a root that holds V2 files',
  'scripts/store-upgrade.mjs': 'the format-1 upgrade (3C-4b stores) seeds the media registry from the store\'s V2 form',
})

const CODE = /\.(?:mjs|cjs|js|ts|tsx)$/
const isTestCode = (file) => /\.(?:test|fixture|spec)\.[^.]+$/.test(file)
const posix = (value) => value.split(path.sep).join('/')
const inCompat = (relative) => COMPAT_DIRECTORIES.some((directory) => relative === directory || relative.startsWith(`${directory}/`))

function* walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) yield* walk(full)
    else if (CODE.test(entry.name)) yield full
  }
}

/** The module specifiers of a source text: static imports, `export … from`, side-effect imports and dynamic imports. */
export function specifiersOf(source) {
  const found = []
  const patterns = [
    /\b(?:import|export)\s+(?:type\s+)?(?:[\w*{}\s,$]+?)\s+from\s+['"]([^'"]+)['"]/g,
    /\bimport\s+['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]
  for (const pattern of patterns) for (const match of source.matchAll(pattern)) found.push(match[1])
  return found
}

/** The compat modules `file` (a path relative to the web root) imports. */
function compatImportsOf(file) {
  const source = readFileSync(path.join(webRoot, file), 'utf8')
  return specifiersOf(source)
    .filter((specifier) => specifier.startsWith('.'))
    .map((specifier) => posix(path.relative(webRoot, path.resolve(path.dirname(path.join(webRoot, file)), specifier))))
    .filter(inCompat)
}

const ordinaryModules = () => [
  ...walk(path.join(webRoot, 'src')), ...walk(path.join(webRoot, 'scripts')), path.join(webRoot, 'vite.config.ts'),
].map((file) => posix(path.relative(webRoot, file))).filter((file) => !isTestCode(file) && !inCompat(file)).sort()

test('the scanner sees static, type-only, re-exported, side-effect and dynamic imports', () => {
  assert.deepEqual(specifiersOf([
    "import { a, b } from '../compat/v2/v2Schema.ts'",
    "import type { V2Files } from './compat/v2/v2Schema.ts'",
    "import x from \"./compat/x.mjs\"",
    "export { y } from './compat/y.mjs'",
    "export * from './compat/z.mjs'",
    "import './compat/side.mjs'",
    "const { run } = await import('./compat/store-migrate.mjs')",
    "import {\n  many,\n  names,\n} from '../compat/v2/migrateV2.ts'",
  ].join('\n')).sort(), [
    '../compat/v2/migrateV2.ts', '../compat/v2/v2Schema.ts', './compat/side.mjs', './compat/store-migrate.mjs', './compat/v2/v2Schema.ts',
    './compat/x.mjs', './compat/y.mjs', './compat/z.mjs',
  ])
})

test('ordinary code imports no compat module, except the scripts listed with a reason', () => {
  const modules = ordinaryModules()
  assert.ok(modules.length > 200, `scanned ${modules.length} modules`)
  assert.ok(modules.includes('src/App.tsx') && modules.includes('scripts/store-session.mjs'), 'the App and the scripts are scanned')
  const violations = []
  const importing = new Set()
  for (const file of modules) {
    const imports = compatImportsOf(file)
    if (!imports.length) continue
    importing.add(file)
    if (!Object.hasOwn(ALLOWED, file)) violations.push(`${file} → ${[...new Set(imports)].join(', ')}`)
  }
  assert.deepEqual(violations, [], 'ordinary read and write code must not import src/data/compat/ or scripts/compat/ (3C-5 E spec §2.4)')
  assert.deepEqual(Object.keys(ALLOWED).filter((file) => !importing.has(file)), [], 'a listed script that no longer imports the compat directories leaves the list')
  assert.ok(Object.keys(ALLOWED).every((file) => file.startsWith('scripts/')), 'no App module is listed')
})

test('every module of the compat directories says it is kept only for the migration, the read-only display and the export', () => {
  const missing = []
  let count = 0
  for (const directory of COMPAT_DIRECTORIES) {
    const root = path.join(webRoot, directory)
    assert.ok(existsSync(root) && statSync(root).isDirectory(), directory)
    for (const file of walk(root)) {
      const relative = posix(path.relative(webRoot, file))
      if (isTestCode(relative)) continue
      count += 1
      const source = readFileSync(file, 'utf8').replace(/\r?\n \* ?/g, ' ')
      const marked = /Compat \(3C-5 E spec §2\.4|兼容（3C-5 E 规格 §2\.4）/.test(source)
      const ruled = /Ordinary read and write code does not import|普通的读写代码不引用兼容目录/.test(source)
      if (!marked || !ruled) missing.push(relative)
    }
  }
  assert.ok(count >= 15, `${count} compat modules`)
  assert.deepEqual(missing, [])
})
