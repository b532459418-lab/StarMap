import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import sharp from 'sharp'
import { exportExchange, importExchange } from './store-exchange.mjs'
import { createEmptyLibrary } from './store-init.mjs'
import { storeFileOf } from './private-data-source.mjs'
import { openReadOnly } from './store-backup.mjs'
import { openStore } from './store-host.mjs'
import { tempPrivateRoot } from './store-mode.fixture.mjs'
import { OFFICIAL, OFFICIAL_POLICY } from '../src/data/store/officialDefinitions.ts'
import { uuidv7 } from '../src/data/canonical/uuidv7.ts'
import { readInterests } from '../src/data/interest/read.ts'
import { defaultLayerId, interestEntityDefinition, interestKinds, interestLayerDefinition, interestLayerOrder } from '../src/data/interest/templates.ts'

const NOW = '2026-11-29T00:00:00.000Z'
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const create = (table, value) => ({ op: 'create', table, value: { revision: 0, ...value } })
const source = (id) => ({ sourceId: OFFICIAL.user, recordId: id, evidenceIds: [] })
const title = (name) => ({ names: { en: name } })

async function writeSample(paths) {
  await createEmptyLibrary(paths, { now: NOW })
  const placeId = uuidv7(), assetId = uuidv7(), photoId = uuidv7(), unrelatedId = uuidv7()
  const image = sharp({ create: { width: 4, height: 3, channels: 3, background: '#276759' } })
  const original = await image.clone().jpeg().toBuffer()
  const thumb = await image.clone().resize({ width: 2 }).webp().toBuffer()
  const hash = sha256(original)
  const directory = 'media/user/' + hash.slice(0, 16)
  const photo = directory + '/original.jpg'
  const unrelated = 'media/user/other.jpg'
  await mkdir(path.join(paths.root, directory), { recursive: true })
  await writeFile(path.join(paths.root, photo), original)
  await writeFile(path.join(paths.root, directory, 'thumb.webp'), thumb)
  await writeFile(path.join(paths.root, unrelated), original)
  const commands = [
    create('entities', { id: placeId, typeId: OFFICIAL.place, title: title('Sample point'), fields: { subtype: 'interest-point' }, source: source(placeId), visibility: 'private' }),
    create('anchors', { id: uuidv7(), entityId: placeId, kind: 'location', lat: 52, lng: 5, precision: 'exact', source: source(placeId) }),
    create('assets', { id: assetId, source: source(assetId), attributes: { kind: 'photo', src: '/' + photo, originalFileName: 'fixture.jpg',
      variants: { thumb: { src: '/' + directory + '/thumb.webp', width: 2, height: 2 } } } }),
    create('assets', { id: unrelatedId, source: source(unrelatedId), attributes: { kind: 'photo', src: '/' + unrelated } }),
    create('entities', { id: photoId, typeId: OFFICIAL.media, title: title('Sample photo'), fields: { place: placeId, asset: assetId }, source: source(photoId), visibility: 'private' }),
  ]
  for (const kind of interestKinds) {
    const definition = interestEntityDefinition(kind)
    const entityType = { ...definition, fields: [...definition.fields, { key: 'photo', kind: 'asset_ref' }] }
    const layerId = defaultLayerId(kind), entityId = uuidv7(), entryId = uuidv7()
    commands.push(
      create('entityTypes', entityType),
      create('layers', interestLayerDefinition(kind, layerId)),
      create('entities', { id: entityId, typeId: entityType.id, title: title('Sample ' + kind),
        fields: kind === 'movie' ? { photo: assetId } : { placeId, photo: unrelatedId }, source: source(entityId), visibility: 'private' }),
      create('entries', { id: entryId, entityId, layerId, createdAt: NOW, updatedAt: NOW, source: source(entryId),
        fields: { status: 'done', rating: 4, note: 'sample ' + kind, ...(kind === 'movie' ? { watchPlaceId: placeId } : {}) } }),
    )
  }
  const order = ['race', 'movie', 'food'].map(defaultLayerId)
  commands.push(create('viewSettings', { id: uuidv7(), ...interestLayerOrder, value: order }))
  const handle = openStore(storeFileOf(paths), { privatePaths: paths, policy: OFFICIAL_POLICY, now: () => NOW })
  try {
    await handle.commit({ kind: 'test.exchange', actor: 'test', requestId: uuidv7(), baseRevision: handle.meta().revision, commands,
      media: {
        files: [{ op: 'put', sha256: hash, extension: '.jpg', bytes: original.length, outputs: [
          { name: 'original.jpg', bytes: original.length, sha256: hash },
          { name: 'thumb.webp', bytes: thumb.length, sha256: sha256(thumb) },
        ] }],
        assetFiles: [{ op: 'put', assetId, sha256: hash }],
      },
    })
  } finally { await handle.close() }
  return { order, photo, original, thumb: directory + '/thumb.webp', thumbBytes: thumb }
}

async function readLibrary(paths) {
  const handle = openReadOnly(storeFileOf(paths))
  try { return { interests: readInterests(handle.readModel()), registry: handle.mediaRegistry(), graph: handle.readFormalState() } }
  finally { await handle.close() }
}

test('personal round trip preserves three layers, their order, photos and typed references', async (t) => {
  const first = await tempPrivateRoot(t, 'starmap-exchange-')
  const second = await tempPrivateRoot(t, 'starmap-exchange-')
  const returned = await tempPrivateRoot(t, 'starmap-exchange-')
  const fixture = await writeSample(first.paths)
  const out = path.join(first.directory, 'exchange')
  assert.equal((await exportExchange(first.paths, { out })).photosAndVariants, 3)
  const preview = await importExchange(second.paths, { from: out })
  assert.equal(preview.applied, false)
  assert.equal((await importExchange(second.paths, { from: out, apply: true })).added, preview.added)
  const replay = await importExchange(second.paths, { from: out, apply: true })
  assert.equal(replay.added, 0)
  assert.equal(replay.revision, preview.revision)
  const back = path.join(second.directory, 'back')
  await exportExchange(second.paths, { out: back })
  await importExchange(returned.paths, { from: back, apply: true })
  const { interests, registry } = await readLibrary(returned.paths)
  assert.deepEqual(interests.layers.map(({ id }) => id), fixture.order)
  assert.deepEqual(interests.records.map(row => row.kind).sort(), [...interestKinds].sort())
  assert.ok(interests.records.every(row => row.entry.fields.note === 'sample ' + row.kind && row.entry.fields.rating === 4 && row.place.location.lat === 52))
  assert.equal(registry.assetFiles.length, 1)
  assert.deepEqual(await readFile(path.join(returned.root, fixture.photo)), fixture.original)
  assert.deepEqual(await readFile(path.join(returned.root, fixture.thumb)), fixture.thumbBytes)

  await writeFile(path.join(out, fixture.thumb), fixture.original)
  await assert.rejects(importExchange(second.paths, { from: out, apply: true }), { code: 'E_EXCHANGE_MEDIA_BYTES' })
  assert.deepEqual(await readFile(path.join(second.root, fixture.thumb)), fixture.thumbBytes)
})

test('selected copy excludes unrelated layers and media and preserves a recipient edit on conflict', async (t) => {
  const first = await tempPrivateRoot(t, 'starmap-exchange-')
  const friend = await tempPrivateRoot(t, 'starmap-exchange-')
  const fixture = await writeSample(first.paths)
  await createEmptyLibrary(friend.paths)
  const scope = { kind: 'selection', entryIds: [], layerIds: [defaultLayerId('movie')] }
  const preview = await exportExchange(first.paths, { scope, preview: true })
  assert.equal(preview.graph.entries.length, 1)
  assert.equal(preview.graph.anchors.length, 1)
  assert.equal(preview.photosAndVariants, 2)
  const out = path.join(first.directory, 'selection')
  await exportExchange(first.paths, { out, scope })
  await importExchange(friend.paths, { from: out, apply: true })
  const friendLibrary = await readLibrary(friend.paths)
  assert.deepEqual(friendLibrary.interests.records.map(row => row.kind), ['movie'])
  assert.equal(friendLibrary.interests.records[0].entity.visibility, 'private')
  assert.equal(friendLibrary.graph.viewSettings.length, 0)
  assert.equal(friendLibrary.registry.files.length, 1)
  assert.equal(friendLibrary.graph.assets.length, 1)
  assert.equal(friendLibrary.graph.assets[0].attributes.originalFileName, undefined)
  assert.deepEqual(await readFile(path.join(friend.root, fixture.photo)), fixture.original)
  assert.equal((await importExchange(friend.paths, { from: out, apply: true })).added, 0)
  const row = friendLibrary.interests.records[0].entry
  const handle = openStore(storeFileOf(friend.paths), { privatePaths: friend.paths, policy: OFFICIAL_POLICY })
  try {
    await handle.commit({ requestId: uuidv7(), baseRevision: handle.meta().revision, kind: 'test.exchange', actor: 'test',
      commands: [{ op: 'update', table: 'entries', id: row.id, expectedRevision: row.revision,
        value: { ...row, revision: row.revision + 1, fields: { ...row.fields, note: 'recipient edit' } } }],
    })
  } finally { await handle.close() }
  await assert.rejects(importExchange(friend.paths, { from: out, apply: true }), { code: 'E_EXCHANGE_CONFLICT' })
  assert.equal((await readLibrary(friend.paths)).interests.records[0].entry.fields.note, 'recipient edit')
})
