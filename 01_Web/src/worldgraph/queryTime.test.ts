/// <reference types="node" />
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PLANNED_SOURCE } from './adapters/plannedRecords.ts'
import { WANT_TO_GO_SOURCE } from './adapters/wantToGo.ts'
import { queryVisiblePlaces } from './query.ts'
import { classifyRecordDate } from './timeFilter.ts'
import type { LayerTimeFilters, OriginalRouteCandidate, TimeQueryContext, TimeQueryRecord } from './timeQuery.ts'
import type { Anchor, Entity, LayerId, LayerMembership, Relation, WorldGraphSnapshot } from './types.ts'

const NOW = '2000-01-01'
const entity = (id: string, subtype: 'country' | 'city'): Entity => ({
  id, type: 'place', subtype, title: { names: { en: id } }, metadata: {}, visibility: 'private', createdAt: NOW, updatedAt: NOW,
})
const location = (entityId: string, lat: number): Anchor => ({ id: `location:${entityId}`, entityId, kind: 'location', lat, lng: 0, precision: 'exact' })
const member = (entityId: string, metadata: Record<string, unknown> = {}): LayerMembership => ({ entityId, layerId: 'travel', addedBy: 'rule', addedAt: NOW, metadata })
const wish = (entityId: string, source: string, recordId: string, hidden = false): LayerMembership => ({
  entityId, layerId: 'want_to_go', recordId, addedBy: 'rule', addedAt: NOW, metadata: { source, hidden },
})
const relation = (id: string, type: Relation['type'], fromEntityId: string, toEntityId: string, metadata?: Relation['metadata']): Relation => ({
  id, type, fromEntityId, toEntityId, provenance: 'rule', ...(metadata ? { metadata } : {}),
})
const visit = (recordId: string, placeId: string, startDate: string | undefined = '2025-06-01', extra: Partial<TimeQueryRecord> = {}): TimeQueryRecord => ({
  sourceKind: 'travel', recordId, placeId, countryId: 'country', journeyId: 'trip',
  browsable: true, date: classifyRecordDate({ startDate }), ...extra,
})
const edge = (id: string, fromRecordId: string, fromPlaceId: string, toRecordId: string, toPlaceId: string): OriginalRouteCandidate => ({
  id, fromRecordId, fromPlaceId, toRecordId, toPlaceId, journeyId: 'trip', kind: 'main',
})
const fixture = (): { snapshot: WorldGraphSnapshot; context: TimeQueryContext } => ({
  snapshot: {
    entities: [entity('country', 'country'), entity('A', 'city'), entity('B', 'city'), entity('C', 'city')],
    memberships: [member('country', { cityIds: ['A', 'B', 'C'] }), member('A'), member('B'), member('C')],
    anchors: [location('A', 0), location('B', 1), location('C', 2)],
    relations: [
      relation('part:A', 'part_of', 'A', 'country'), relation('part:B', 'part_of', 'B', 'country'), relation('part:C', 'part_of', 'C', 'country'),
      relation('old:AB', 'related_to', 'A', 'B', { routeId: 'legacy-AB', journeyId: 'trip', type: 'drive' }),
      relation('old:BC', 'related_to', 'B', 'C', { routeId: 'legacy-BC', journeyId: 'trip', type: 'ferry' }),
    ],
  },
  context: { records: [visit('r-A', 'A'), visit('r-B', 'B'), visit('r-C', 'C')], originalRoutes: [edge('original-AB', 'r-A', 'A', 'r-B', 'B'), edge('original-BC', 'r-B', 'B', 'r-C', 'C')] },
})
const year2025 = { from: '2025-01-01', to: '2025-12-31', includeUncertain: false }
const run = (data: ReturnType<typeof fixture>, filters: LayerTimeFilters = { travel: year2025 }, layers: readonly LayerId[] = ['travel', 'want_to_go']) =>
  queryVisiblePlaces(data.snapshot, layers, { context: data.context, filters })

test('omitted conditions, empty conditions and only uncertain toggle return the exact legacy output', () => {
  const data = fixture()
  const before = queryVisiblePlaces(data.snapshot, ['travel', 'want_to_go'])
  assert.equal(before.routes.length, 2)
  assert.deepEqual(run(data, {}), before)
  assert.deepEqual(run(data, { travel: { includeUncertain: true }, want_to_go: { includeUncertain: false } }), before)
  assert.equal(before.routes[0].id, 'legacy-AB')
})

test('only want-to-go filtering keeps travel route IDs, order, coordinates and kinds exactly', () => {
  const data = fixture()
  data.snapshot.memberships.push(wish('A', WANT_TO_GO_SOURCE, 'wish-A'))
  data.context = { ...data.context, records: [...data.context.records, visit('wish-A', 'A', '2022-01-01', { sourceKind: 'want-to-go' })] }
  const before = queryVisiblePlaces(data.snapshot, ['travel', 'want_to_go'])
  const result = run(data, { want_to_go: year2025 })
  assert.deepEqual(result.routes, before.routes)
  assert.deepEqual(result.places.find(place => place.entityId === 'A')!.layerIds, ['travel'])
})

test('an active travel condition leaves an unfiltered want-to-go layer independently visible', () => {
  const data = fixture()
  data.context = { ...data.context, records: data.context.records.map(entry => ({ ...entry, date: classifyRecordDate({ startDate: '2022-01-01' }) })) }
  data.snapshot.memberships.push(wish('A', WANT_TO_GO_SOURCE, 'wish-A'))
  const result = run(data)
  assert.deepEqual(result.places.map(place => [place.entityId, place.layerIds, place.visitCount]), [['A', ['want_to_go'], 0]])
  assert.deepEqual(result.routes, [])
})

test('same-place source collisions select the matching planned record instead of excluded ordinary wish', () => {
  const data = fixture()
  data.snapshot.memberships.push(wish('A', WANT_TO_GO_SOURCE, 'same'), wish('A', PLANNED_SOURCE, 'same'))
  data.context = { ...data.context, records: [...data.context.records,
    visit('same', 'A', '2022-01-01', { sourceKind: 'want-to-go' }), visit('same', 'A', '2027-01-01', { sourceKind: 'planned' }),
  ] }
  const result = run(data, { want_to_go: { from: '2027-01-01', to: '2027-12-31', includeUncertain: false } })
  const place = result.places.find(entry => entry.entityId === 'A')!
  assert.deepEqual(place.recordRefs?.want_to_go, [{ sourceKind: 'planned', recordId: 'same' }])
  assert.equal(place.membershipMetadata.want_to_go?.source, PLANNED_SOURCE)
  assert.deepEqual(place.recordIds?.want_to_go, ['same'])
})

test('active filters never bridge hidden, excluded or coordinate-less middle visits', () => {
  for (const mode of ['hidden', 'excluded', 'coordinates'] as const) {
    const data = fixture()
    if (mode === 'hidden') data.context = { ...data.context, records: data.context.records.map(entry => entry.recordId === 'r-B' ? { ...entry, browsable: false } : entry) }
    if (mode === 'excluded') data.context = { ...data.context, records: data.context.records.map(entry => entry.recordId === 'r-B' ? { ...entry, date: classifyRecordDate({ startDate: '2022-01-01' }) } : entry) }
    if (mode === 'coordinates') data.snapshot.anchors = data.snapshot.anchors.filter(anchor => anchor.entityId !== 'B')
    const result = run(data)
    assert.deepEqual(result.places.map(place => place.entityId), ['A', 'C'], mode)
    assert.deepEqual(result.routes, [], mode)
  }
})

test('strict routes preserve original endpoint identities and legitimate zero coordinates', () => {
  const result = run(fixture())
  assert.deepEqual(result.routes.map(route => [route.id, route.fromRecordId, route.toRecordId, route.kind, route.dateMatch]), [
    ['original-AB', 'r-A', 'r-B', 'main', 'definite'], ['original-BC', 'r-B', 'r-C', 'main', 'definite'],
  ])
  assert.equal(result.routes[0].fromLat, 0)
  assert.equal(result.routes[0].fromLng, 0)
})

test('a repeated city cannot use a different visit to rescue the exact original route endpoint', () => {
  const data = fixture()
  data.context = {
    records: [visit('r-A-old', 'A', '2022-01-01'), visit('r-A-new', 'A'), visit('r-C', 'C')],
    originalRoutes: [edge('old-A-to-C', 'r-A-old', 'A', 'r-C', 'C')],
  }
  const result = run(data)
  assert.deepEqual(result.places.map(place => place.entityId), ['A', 'C'])
  assert.equal(result.places[0].visitCount, 1)
  assert.deepEqual(result.places[0].recordRefs?.travel, [{ sourceKind: 'travel', recordId: 'r-A-new' }])
  assert.deepEqual(result.routes, [])
})

test('uncertain endpoints require the include option and mark retained reliable original edges', () => {
  const data = fixture()
  data.context = { ...data.context, records: data.context.records.map(entry => entry.recordId === 'r-B' ? { ...entry, date: classifyRecordDate({}) } : entry) }
  assert.deepEqual(run(data).routes, [])
  const included = run(data, { travel: { ...year2025, includeUncertain: true } })
  assert.equal(included.routes.length, 2)
  assert.ok(included.routes.every(route => route.dateMatch === 'uncertain'))
  const hidden = { ...data, context: { ...data.context, records: data.context.records.map(entry => entry.recordId === 'r-B' ? { ...entry, browsable: false } : entry) } }
  assert.deepEqual(run(hidden, { travel: { ...year2025, includeUncertain: true } }).routes, [])
})

test('strict routes reject mismatched journey or endpoint provenance and do not fall back to legacy edges', () => {
  for (const change of ['journey', 'place', 'missing-record'] as const) {
    const data = fixture()
    data.context = { ...data.context, originalRoutes: [{ ...data.context.originalRoutes[0],
      ...(change === 'journey' ? { journeyId: 'wrong-trip' } : {}),
      ...(change === 'place' ? { fromPlaceId: 'C' } : {}),
      ...(change === 'missing-record' ? { fromRecordId: 'missing' } : {}),
    }] }
    assert.deepEqual(run(data).routes, [], change)
  }
})

test('closing the travel layer removes all routes without suppressing matching wish markers', () => {
  const data = fixture()
  data.snapshot.memberships.push(wish('A', WANT_TO_GO_SOURCE, 'wish'))
  data.context = { ...data.context, records: [...data.context.records, visit('wish', 'A', '2025-01-01', { sourceKind: 'want-to-go' })] }
  const result = run(data, { travel: year2025, want_to_go: year2025 }, ['want_to_go'])
  assert.deepEqual(result.routes, [])
  assert.deepEqual(result.places.map(place => [place.entityId, place.layerIds]), [['A', ['want_to_go']]])
})

test('hidden memberships stay hidden even when source evidence matches and uncertain inclusion is enabled', () => {
  const data = fixture()
  data.snapshot.memberships.push(wish('A', WANT_TO_GO_SOURCE, 'hidden', true))
  data.context = { ...data.context, records: [...data.context.records, visit('hidden', 'A', undefined, { sourceKind: 'want-to-go' })] }
  const result = run(data, { want_to_go: { ...year2025, includeUncertain: true } }, ['want_to_go'])
  assert.deepEqual(result.places, [])
})

test('all query branches accept frozen data and clearing conditions restores the legacy map exactly', () => {
  const data = fixture()
  const baseline = queryVisiblePlaces(data.snapshot, ['travel', 'want_to_go'])
  const before = JSON.stringify(data)
  const freeze = (value: unknown): void => {
    if (value === null || typeof value !== 'object') return
    Object.values(value).forEach(freeze)
    Object.freeze(value)
  }
  freeze(data)
  const filters = { travel: { ...year2025 }, want_to_go: { ...year2025 } }
  freeze(filters)
  assert.equal(run(data, filters).routes.length, 2)
  assert.deepEqual(run(data, {}), baseline)
  assert.equal(JSON.stringify(data), before)
})
