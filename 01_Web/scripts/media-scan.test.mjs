/**
 * The new library's Inbox scan (3C-4c, ./media-scan.mjs): one fact per file (no merging by content), the importer's own
 * folder rules and messages, the scan cache, the description digest, and describeMediaFile's per-file checks.
 * Temporary private roots with the invented registry and synthetic images of ./media-inbox.fixture.mjs.
 */
import assert from 'node:assert/strict'
import { utimes, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { sha256File } from './file-hash.mjs'
import { COLOR, PLACE, inboxFile, makeImage, syntheticPlaces, writeJson, writeSyntheticInbox } from './media-inbox.fixture.mjs'
import { IMPORT_BLOCKING_PATTERN, describeMediaFile, descriptionDigestOf, scanCacheEntriesOf, scanInbox } from './media-scan.mjs'
import { pathKeyOf } from './store-media-registry.mjs'
import { tempPrivateRoot } from './store-mode.fixture.mjs'

/** A scan with a hash counter. */
async function counted(paths, cache = []) {
  let calls = 0
  const result = await scanInbox({ privatePaths: paths, places: syntheticPlaces(), cache, hashFile: (file) => { calls += 1; return sha256File(file) } })
  return { ...result, calls }
}
const cacheOf = (facts) => scanCacheEntriesOf(facts).map(({ path: pathValue, size, mtimeMs, sha256 }) => ({ pathKey: pathKeyOf(pathValue), size, mtimeMs, sha256 }))

test('the page import blocks on every stop condition of the former editor importer, folder bindings to confirm included (moved here in 3C-4d)', () => {
  for (const warning of ['需要处理', '缺少日期或分辨率', '缺少日期、分辨率或有效坐标', '无法读取', '找不到国家', '找不到城市', '待确认的文件夹绑定']) {
    assert.match(`Synthland/Harbor Town：${warning}：待确认`, IMPORT_BLOCKING_PATTERN, warning)
  }
  for (const advisory of ['发现 1 个内容完全相同的重复文件', '预检通过']) assert.doesNotMatch(advisory, IMPORT_BLOCKING_PATTERN, advisory)
})

test('one fact per file in walk order, files of the same content kept apart, with their place, kind and sidecar entry', async (t) => {
  const { paths } = await tempPrivateRoot(t, 'starmap-media-scan-')
  const files = await writeSyntheticInbox(paths)
  const { facts, errors, warnings, pins, hashed } = await counted(paths)
  assert.deepEqual(errors, [])
  assert.deepEqual(warnings, [])
  // The importer's order: folders and files sorted with the zh-CN collation.
  assert.deepEqual(facts.map((fact) => fact.path), [files.pano, files.aCopy, files.a, files.b, files.c])
  assert.equal(hashed, 5)
  const byPath = new Map(facts.map((fact) => [fact.path, fact]))
  assert.equal(byPath.get(files.a).sha256, byPath.get(files.aCopy).sha256, 'the same content in two files: two facts (D2)')
  assert.equal(byPath.get(files.a).sha256, await sha256File(inboxFile(paths, files.a)))
  assert.deepEqual([byPath.get(files.a).placeId, byPath.get(files.a).kind, byPath.get(files.a).metadata], [PLACE.harbor, 'photo', {}])
  const pano = byPath.get(files.pano)
  assert.deepEqual([pano.placeId, pano.kind, pano.unlabelled, pano.metadata.date], [PLACE.river, 'panorama360', false, '2026-07-03'])
  assert.deepEqual([pano.countryFolder, pano.cityFolder], ['MediaInbox/Second Land', 'MediaInbox/Second Land/River Town'])
  assert.equal(pano.descriptionDigest, descriptionDigestOf({ placeId: PLACE.river, kind: 'panorama360', metadata: pano.metadata }))
  // The Hill Town folder resolves by its name only: a binding to confirm, listed with its portable folder.
  assert.deepEqual(pins.map(({ folder, placeId }) => ({ folder, placeId })), [{ folder: 'MediaInbox/Synthland/Hill Town', placeId: PLACE.hill }])
})

test('the importer’s folder and format rules apply unchanged: errors and warnings for the same files', async (t) => {
  const { paths } = await tempPrivateRoot(t, 'starmap-media-scan-')
  await writeSyntheticInbox(paths)
  await writeFile(path.join(paths.inboxRoot, 'Synthland', 'Harbor Town', 'photos', 'raw.heic'), 'not converted')
  await writeFile(path.join(paths.inboxRoot, 'Synthland', 'Harbor Town', 'photos', 'notes.txt'), 'not media')
  await makeImage(path.join(paths.inboxRoot, 'Nowhere', 'Some City', 'photos', 'x.jpg'), { color: COLOR.grey })
  await makeImage(path.join(paths.inboxRoot, 'Second Land', 'River Town', 'drone', 'flight.jpg'), { color: COLOR.purple })
  const { facts, errors, warnings } = await counted(paths)
  assert.equal(errors.length, 2, errors.join('\n'))
  assert.match(errors.join('\n'), /raw\.heic 需要先转换成网页格式/)
  assert.match(errors.join('\n'), /Nowhere/)
  assert.deepEqual(warnings, ['Synthland/Harbor Town/photos/notes.txt 不是支持的媒体格式，已忽略。'])
  const flight = facts.find((fact) => fact.path.endsWith('flight.jpg'))
  assert.deepEqual([flight.kind, flight.unlabelled], ['aerialPhoto', true], 'unlabelled: the reminder comes with describeMediaFile, for new files only')
})

test('the scan cache: a path whose size and modification time match is not hashed again; any change is', async (t) => {
  const { paths } = await tempPrivateRoot(t, 'starmap-media-scan-')
  const files = await writeSyntheticInbox(paths)
  const first = await counted(paths)
  assert.equal(first.calls, 5)
  const second = await counted(paths, cacheOf(first.facts))
  assert.equal(second.calls, 0)
  assert.ok(second.facts.every((fact) => fact.fromCache))
  assert.deepEqual(second.facts.map((fact) => fact.sha256), first.facts.map((fact) => fact.sha256))
  // New content (another size) and a touched file (same content, another time) are hashed again; the rest is not.
  await makeImage(inboxFile(paths, files.b), { width: 80, height: 40, color: COLOR.purple })
  const later = new Date(Date.now() + 60_000)
  await utimes(inboxFile(paths, files.c), later, later)
  const third = await counted(paths, cacheOf(first.facts))
  assert.equal(third.calls, 2)
  const b = third.facts.find((fact) => fact.path === files.b)
  assert.equal(b.fromCache, false)
  assert.equal(b.sha256, await sha256File(inboxFile(paths, files.b)))
  // Without a cache every file is hashed: emptying it only makes the scan slower.
  assert.equal((await counted(paths, [])).calls, 5)
})

test('the description digest follows the file’s place, kind and sidecar entry, and nothing else', async (t) => {
  const { paths } = await tempPrivateRoot(t, 'starmap-media-scan-')
  const files = await writeSyntheticInbox(paths)
  const before = new Map((await counted(paths)).facts.map((fact) => [fact.path, fact.descriptionDigest]))
  const sidecar = path.join(paths.inboxRoot, 'Second Land', 'River Town', 'media.json')
  await writeJson(sidecar, {
    'drone/pano-1.jpg': { kind: 'panorama360', titleEn: 'Synthetic panorama, renamed', date: '2026-07-03', resolution: '200 × 100' },
    'drone/other.jpg': { kind: 'aerialPhoto' },
  })
  const after = new Map((await counted(paths)).facts.map((fact) => [fact.path, fact.descriptionDigest]))
  assert.notEqual(after.get(files.pano), before.get(files.pano))
  for (const key of [files.a, files.aCopy, files.b, files.c]) assert.equal(after.get(key), before.get(key))
})

test('describeMediaFile: the record a fact becomes, and the importer’s per-file checks', async (t) => {
  const { paths } = await tempPrivateRoot(t, 'starmap-media-scan-')
  const files = await writeSyntheticInbox(paths)
  await makeImage(path.join(paths.inboxRoot, 'Second Land', 'River Town', 'drone', 'wide-360.jpg'), { width: 120, height: 100, color: COLOR.grey })
  await makeImage(path.join(paths.inboxRoot, 'Second Land', 'River Town', 'drone', 'undated.jpg'), { color: COLOR.purple })
  await writeJson(path.join(paths.inboxRoot, 'Second Land', 'River Town', 'media.json'), {
    'drone/pano-1.jpg': { kind: 'panorama360', titleEn: 'Synthetic panorama', date: '2026-07-03', resolution: '200 × 100' },
    'drone/undated.jpg': { kind: 'aerialPhoto' },
  })
  const { facts } = await counted(paths)
  const fact = (suffix) => facts.find((item) => item.path.endsWith(suffix))
  const a = await describeMediaFile(fact('/a.jpg'))
  assert.deepEqual([a.errors, a.warnings], [[], []])
  assert.deepEqual([a.item.kind, a.item.placeId, a.item.width, a.item.height, a.item.status], ['photo', PLACE.harbor, 64, 48, 'ready'])
  const directory = fact('/a.jpg').sha256.slice(0, 16)
  assert.equal(a.item.src, `/media/user/${directory}/original.jpg`)
  assert.deepEqual(a.generated, {
    directory: `media/user/${directory}`, original: `media/user/${directory}/original.jpg`,
    derivatives: [
      { file: `media/user/${directory}/thumb.webp`, maxEdge: 640, quality: 76 },
      { file: `media/user/${directory}/preview.webp`, maxEdge: 2400, quality: 84 },
    ],
  })
  const pano = await describeMediaFile(fact(files.pano.slice(files.pano.lastIndexOf('/'))))
  assert.deepEqual([pano.item.kind, pano.item.date, pano.item.title], ['panorama360', '2026-07-03', { names: { en: 'Synthetic panorama' } }])
  const wide = await describeMediaFile(fact('/wide-360.jpg'))
  assert.match(wide.errors.join('\n'), /不是常见的 2:1 等距柱状全景图/)
  assert.equal(wide.item, undefined)
  const undated = await describeMediaFile(fact('/undated.jpg'))
  assert.deepEqual(undated.warnings, ['Second Land/River Town/drone/undated.jpg 缺少日期或分辨率；会进入目录，但暂不显示为 Drone Media。'])
  const broken = await describeMediaFile({ ...fact('/b.jpg') }, { readImage: async () => { throw new Error('decoder failed') } })
  assert.deepEqual(broken.errors, ['Synthland/Harbor Town/photos/b.jpg 无法读取图片尺寸：decoder failed'])
  const large = await describeMediaFile({ ...fact('/b.jpg'), size: 20 * 1024 * 1024 })
  assert.deepEqual(large.advisoryWarnings, ['Synthland/Harbor Town/photos/b.jpg 为 20.0 MiB，建议 Agent 生成更轻的网页版本。'])
})
