/**
 * 冻结夹具（RFC-LOC-1 PR5b §4.1）在脚本测试一侧的原生成方式。只在冻结那一个提交里存在：
 * `frozen-fixtures.equivalence.test.mjs` 用它证明 `scripts/fixtures/` 下的静态 V2 文件与 migrate-identity 现场迁移的结果相同；
 * 下一个提交删除迁移工具时两者一起删除。
 *
 * 三个脚本测试原来在临时私人根里写中性旧数据（公开旧样例加几处改动），再跑 migrate-identity 的 dry-run 与 --apply：
 * - `bak-files-v2.json`：bak-files.test.mjs「.bak 在 data/v2/」；
 * - `baseline-v2.json`：legacy-baseline.test.mjs 的 prepareV2Root；
 * - `editor-store-v2.json`：v2-editor-store.test.mjs 的 writeLegacyData。
 * 下面三个 setup 与原测试写旧文件的代码逐字相同。
 *
 * 迁移工具的地点 id 是随机的 UUIDv7，地点注册表的 generated_at 是运行时刻，所以「相同」指：UUID 按首次出现的顺序
 * 换成确定的序列（`sequentialUuids()`）、运行时刻换成固定值之后逐项相同（`canonicalizeMigratedFiles`）。
 * 冻结文件本身就是这样换过的结果，这个变换对它是恒等的。
 */

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { webRoot } from './private-profile.mjs'
import { sequentialUuids } from '../src/data/canonical/v2.fixture.ts'
import { V2_FILE_KEYS, V2_FILE_NAMES } from '../src/data/canonical/v2Schema.ts'

/** 冻结文件里地点注册表的 generated_at（原来是迁移的运行时刻）。 */
export const FROZEN_GENERATED_AT = '2026-09-30T00:00:00.000Z'

const readSample = (name) => JSON.parse(readFileSync(path.join(webRoot, 'src', 'data', name), 'utf8'))

const dataPath = (root, name) => path.join(root, 'data', name)

/** bak-files.test.mjs 的 writeJson：两空格缩进加换行。 */
const writePretty = async (target, value) => {
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

/** legacy-baseline.test.mjs 的 writePrivate：不缩进。 */
const writeCompact = async (target, value) => {
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, JSON.stringify(value), 'utf8')
}

/** 冻结文件名 → 在私人根里写旧数据（与原测试相同）。 */
export const FROZEN_V2_SOURCES = {
  'bak-files-v2.json': async (root) => {
    const travel = readSample('travel-map.sample.json')
    travel.privacy_level = 'local-only'
    await writePretty(dataPath(root, 'travel-map.local.json'), travel)
    await writePretty(dataPath(root, 'want-to-go.local.json'), readSample('want-to-go.sample.json'))
  },
  'baseline-v2.json': async (root) => {
    const travel = readSample('travel-map.sample.json')
    travel.privacy_level = 'local-only'
    await writeCompact(dataPath(root, 'travel-map.local.json'), travel)
    await writeCompact(dataPath(root, 'want-to-go.local.json'), readSample('want-to-go.sample.json'))
    await writeCompact(dataPath(root, 'editor-state.local.json'), { schemaVersion: 1, hiddenCityIds: ['iceland__vik'], countryOrder: ['faroe-islands', 'iceland'] })
  },
  'editor-store-v2.json': async (root) => {
    const travel = readSample('travel-map.sample.json')
    travel.privacy_level = 'local-only'
    travel.display.countryCodes = { ...travel.display.countryCodes, Norway: 'no' }
    travel.records.push({
      id: 'planned_bergen', country: '挪威', country_en: 'Norway', country_code: 'no', city: '卑尔根', city_en: 'Bergen',
      start_date: '2027-06-01', year: 2027, trip_title: '2027 Fjord Plan', status: 'planned', lat: 60.3913, lng: 5.3221,
    })
    const want = readSample('want-to-go.sample.json')
    want.items[1].hidden = true
    await writePretty(dataPath(root, 'travel-map.local.json'), travel)
    await writePretty(dataPath(root, 'want-to-go.local.json'), want)
    await writePretty(dataPath(root, 'editor-state.local.json'), {
      schemaVersion: 1,
      countryOrder: ['faroe-islands', 'iceland'],
      hiddenCityIds: ['iceland__vik'],
      coverMediaByCity: { iceland__reykjavik: 'photo-1' },
    })
    await writePretty(dataPath(root, 'user-media.local.json'), {
      schemaVersion: 2,
      generatedAt: '2026-09-01T00:00:00.000Z',
      items: [
        {
          id: 'photo-1', kind: 'photo', scope: 'city', countryId: 'iceland', countryName: 'Iceland', cityId: 'iceland__reykjavik', cityName: 'Reykjavik',
          src: '/media/user/sample/photo-1.jpg', originalFileName: 'photo-1.jpg', isCover: false, status: 'ready',
        },
        {
          id: 'drone-1', kind: 'aerialPhoto', scope: 'city', countryId: 'faroe-islands', countryName: 'Faroe Islands', cityId: 'faroe-islands__torshavn', cityName: 'Torshavn',
          src: '/media/user/sample/drone-1.jpg', originalFileName: 'drone-1.jpg', isCover: false, status: 'ready', date: '2025-06-06', resolution: '4000x3000',
        },
      ],
    })
  },
}

const runMigrate = (args, privateRoot) => spawnSync(process.execPath, [path.join(webRoot, 'scripts', 'migrate-identity.mjs'), ...args], {
  cwd: webRoot,
  env: { ...process.env, STARMAP_PRIVATE_ROOT: privateRoot },
  encoding: 'utf8',
})

/** 与原测试相同：dry-run，再 --apply。返回两次运行的结果。 */
export const migrateInto = (root) => {
  const dryRun = runMigrate([], root)
  const applied = runMigrate(['--apply'], root)
  return { dryRun, applied }
}

/** 读私人根 data/v2/ 的五个 V2 文件（键顺序同 V2_FILE_KEYS）。 */
export const readMigratedFiles = async (root) => Object.fromEntries(await Promise.all(V2_FILE_KEYS.map(async (key) => [
  key, JSON.parse(await readFile(path.join(root, 'data', 'v2', V2_FILE_NAMES[key]), 'utf8')),
])))

const UUID_V7 = /[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/g

/**
 * UUID 按在文本里首次出现的顺序换成 `sequentialUuids()` 的序列；地点注册表的 generated_at（迁移的运行时刻）
 * 在全文里换成 FROZEN_GENERATED_AT。只改这两样。
 */
export const canonicalizeMigratedFiles = (files) => {
  const runTime = files.places.generated_at
  const next = sequentialUuids()
  const renamed = new Map()
  const text = JSON.stringify(files)
    .replace(UUID_V7, (uuid) => {
      if (!renamed.has(uuid)) renamed.set(uuid, next())
      return renamed.get(uuid)
    })
    .replaceAll(JSON.stringify(runTime), JSON.stringify(FROZEN_GENERATED_AT))
  return JSON.parse(text)
}
