/// <reference types="node" />
/**
 * The store-native want-to-go writes (3C-5 C1): the rows they write (sources, ids, view rows), and the cleanup of
 * places after a delete, which looks at the references of every layer (spec §2.5, external review D3). The results and
 * refusals are pinned by the golden output (../golden.test.ts).
 */
import { test } from 'node:test'
import type { FormalState } from '../../../worldgraph/store/formal.ts'
import assert from 'node:assert/strict'
import { viewOf } from '../../store/v2Store.fixture.ts'
import { OFFICIAL, VIEW_SCOPES } from '../../store/officialDefinitions.ts'
import { migratedFiles, placeNamed } from '../editor.fixture.ts'
import { doubleRunStore } from '../doubleRun.fixture.ts'
import { canonicalOf, commitAsIs, customEntryOn, landmarkNear, runNative } from './native.fixture.ts'

const run = runNative
const commit = commitAsIs

test('POST /wanttogo: new rows are starmap:user rows with their own ids; the entry and new places join their orders; no V2-only value', () => {
  const store = doubleRunStore(migratedFiles())
  const before = store.state
  const added = run(store, 'wanttogo', { place: { kind: 'city', nameZh: '大阪', nameEn: 'Osaka', countryCode: 'JP', lat: 34.69, lng: 135.5 }, note: 'Synthetic' }, 1)
  assert.ok(added.state, JSON.stringify(added.error))
  const result = added.result as { id: string; item: Record<string, unknown> }
  assert.deepEqual(result.item, {
    id: result.id, place: { kind: 'city', nameZh: '大阪', nameEn: 'Osaka', countryCode: 'JP', lat: 34.69, lng: 135.5 }, addedAt: '2026-09-27', hidden: false, note: 'Synthetic',
  })
  const rows = (state: FormalState, table: keyof FormalState) => state[table] as unknown as readonly { id: string }[]
  const fresh = (table: keyof FormalState) => rows(store.state, table).filter((row) => !rows(before, table).some((old) => old.id === row.id))
  // Japan and Osaka (entities), Japan's and Osaka's anchors, Osaka's part-of, the entry.
  for (const table of ['entities', 'anchors', 'relations', 'entries'] as const) {
    for (const row of fresh(table) as unknown as { id: string; source: { sourceId: string; recordId: string } }[]) {
      assert.deepEqual([row.source.sourceId, row.source.recordId], [OFFICIAL.user, row.id], `${table} ${row.id}`)
      assert.match(row.id, /^[0-9a-f]{8}-[0-9a-f]{4}-7/)
    }
  }
  assert.deepEqual([fresh('entities').length, fresh('anchors').length, fresh('relations').length, fresh('entries').length], [2, 2, 1, 1])
  const items = fresh('viewItems') as unknown as { scope: string; itemId: string }[]
  assert.deepEqual(items.map((item) => item.scope).sort(), [VIEW_SCOPES.placeOrder, VIEW_SCOPES.placeOrder, VIEW_SCOPES.wantToGoOrder].sort())
  assert.equal(JSON.stringify(store.state).includes('local-editor'), JSON.stringify(before).includes('local-editor'), 'no new local-editor value')
  // In the official view: the item last, the places last in the registry.
  const canonical = canonicalOf(store.state)
  assert.equal(canonical.wantToGo.items.at(-1)!.id, result.id)
  assert.deepEqual(canonical.places.slice(-2).map((place) => place.names.en), ['Japan', 'Osaka'])
  // A later write reads and changes the native rows: the note of the new item.
  const updated = run(store, 'wanttogo/update', { id: result.id, note: 'Synthetic later' }, 2)
  assert.equal(canonicalOf(updated.state!).wantToGo.items.at(-1)!.note, 'Synthetic later')
})

test('POST /wanttogo/update: a note is one entry update; hiding adds the hidden row, showing removes it; nothing to change is no command', () => {
  const store = doubleRunStore(migratedFiles())
  const files = viewOf(store.state)
  const nuuk = files.wantToGo.items.find((item) => item.placeId === placeNamed(files, 'Nuuk').id)!
  const note = run(store, 'wanttogo/update', { id: nuuk.id, note: '  Synthetic note  ' }, 1)
  assert.equal(note.commands, 1)
  assert.equal((note.result as { item: { note: string } }).item.note, 'Synthetic note')
  const hide = run(store, 'wanttogo/update', { id: nuuk.id, hidden: true }, 2)
  assert.equal(hide.commands, 1)
  assert.equal(canonicalOf(store.state).wantToGo.items.find((item) => item.id === nuuk.id)!.hidden, true)
  const again = run(store, 'wanttogo/update', { id: nuuk.id, hidden: true }, 3)
  assert.equal(again.commands, 0)
  const show = run(store, 'wanttogo/update', { id: nuuk.id, hidden: false, note: '' }, 4)
  assert.equal(show.commands, 2)
  const item = canonicalOf(store.state).wantToGo.items.find((value) => value.id === nuuk.id)!
  assert.deepEqual([item.hidden, item.note], [false, undefined])
  assert.equal(store.state.viewItems.some((row) => row.scope === VIEW_SCOPES.wantToGoHidden && row.itemId === nuuk.id), false)
})

test('D3: deleting a want-to-go item keeps a city that a custom layer\'s entity or entry still refers to (design §9 change 9)', () => {
  for (const [label, custom] of [['an entity field of a custom layer', landmarkNear], ['an entry of a custom layer', customEntryOn]] as const) {
    const store = doubleRunStore(migratedFiles())
    const files = viewOf(store.state)
    const tromso = placeNamed(files, 'Tromsø').id
    const wish = files.wantToGo.items.find((item) => item.placeId === tromso)!
    assert.equal(wish.hidden, true, 'the fixture\'s Tromsø item is hidden')
    commit(store, custom(tromso))
    const deleted = run(store, 'wanttogo/delete', { ids: [wish.id] }, 1)
    assert.deepEqual(deleted.result, { deletedIds: [wish.id] }, label)
    const canonical = canonicalOf(store.state)
    assert.equal(canonical.wantToGo.items.some((item) => item.id === wish.id), false, label)
    assert.ok(canonical.places.some((place) => place.id === tromso), `${label}: Tromsø stays`)
    assert.ok(store.state.entities.some((row) => row.id === tromso), label)
  }
})

test('D3, the other way: a city only the deleted item referred to goes, and a country only that city referred to goes with it', () => {
  // Tromsø (its wish only): deleted; Norway stays (other records refer to it).
  const store = doubleRunStore(migratedFiles())
  const files = viewOf(store.state)
  const tromso = placeNamed(files, 'Tromsø').id, norway = placeNamed(files, 'Norway').id
  run(store, 'wanttogo/delete', { ids: [files.wantToGo.items.find((item) => item.placeId === tromso)!.id] }, 1)
  assert.equal(store.state.entities.some((row) => row.id === tromso), false)
  assert.equal(store.state.anchors.some((row) => row.entityId === tromso) || store.state.relations.some((row) => row.fromEntityId === tromso), false)
  assert.ok(store.state.entities.some((row) => row.id === norway))
  // Osaka in a new Japan, hidden, deleted: both places go, with their anchors, relation and order rows.
  const added = run(store, 'wanttogo', { place: { kind: 'city', nameEn: 'Osaka', countryCode: 'JP', lat: 34.69, lng: 135.5 } }, 2)
  const { id } = added.result as { id: string }
  run(store, 'wanttogo/update', { id, hidden: true }, 3)
  const japan = canonicalOf(store.state).places.find((place) => place.names.en === 'Japan')!.id
  const osaka = canonicalOf(store.state).places.find((place) => place.names.en === 'Osaka')!.id
  run(store, 'wanttogo/delete', { ids: [id] }, 4)
  for (const placeId of [japan, osaka]) {
    assert.equal(store.state.entities.some((row) => row.id === placeId), false, placeId)
    assert.equal(store.state.viewItems.some((row) => row.itemId === placeId), false, placeId)
  }
  assert.equal(store.state.entries.some((row) => row.id === id), false)
  // And with a custom layer's entry on Osaka's country, Japan stays while Osaka goes.
  const again = run(store, 'wanttogo', { place: { kind: 'city', nameEn: 'Osaka', countryCode: 'JP', lat: 34.69, lng: 135.5 } }, 5)
  const japan2 = canonicalOf(store.state).places.find((place) => place.names.en === 'Japan')!.id
  commit(store, customEntryOn(japan2))
  run(store, 'wanttogo/update', { id: (again.result as { id: string }).id, hidden: true }, 6)
  run(store, 'wanttogo/delete', { ids: [(again.result as { id: string }).id] }, 7)
  assert.ok(store.state.entities.some((row) => row.id === japan2), 'Japan stays')
  assert.equal(canonicalOf(store.state).places.some((place) => place.names.en === 'Osaka'), false, 'Osaka goes')
})

test('a later write that changes a place the native write created (a record that fills its location) keeps the place\'s starmap:user source', () => {
  const store = doubleRunStore(migratedFiles())
  const added = run(store, 'wanttogo', { place: { kind: 'city', nameEn: 'Synthetic Town', countryCode: 'IS' } }, 1)
  const placeId = (canonicalOf(store.state).wantToGo.items.find((item) => item.id === (added.result as { id: string }).id)!).placeId
  // POST /records by place id fills the city's missing location.
  const record = run(store, 'records', { placeId, start_date: '2026-05-01', lat: 64.1, lng: -21.9 }, 2)
  assert.ok(record.state, JSON.stringify(record.error))
  const entity = record.state.entities.find((row) => row.id === placeId)!
  assert.deepEqual([entity.source.sourceId, entity.source.recordId], [OFFICIAL.user, placeId])
  assert.deepEqual(canonicalOf(record.state).places.find((place) => place.id === placeId)!.location, { lat: 64.1, lng: -21.9 })
})
