/**
 * Indexes of a snapshot's entities and anchors, built once per array (3C-5 D): the place query (./query.ts) and the
 * Collection (./collection.ts) both look entities and locations up by id; built for each query, the same indexes were
 * made twice per snapshot. Kept in WeakMaps by the arrays themselves (a new snapshot has new arrays), read only.
 *
 * - `entityIndexOf(entities)`: id → the first entity with that id.
 * - `locationIndexOf(anchors)`: entity id → its first `location` anchor with finite coordinates.
 *
 * Constraint: erasable-only TypeScript (Node loads it directly); no dependency on the presentation layer.
 */
import type { Anchor, Entity, EntityId } from './types.ts'

const entityIndexes = new WeakMap<readonly Entity[], ReadonlyMap<EntityId, Entity>>()
const locationIndexes = new WeakMap<readonly Anchor[], ReadonlyMap<EntityId, Anchor>>()

const isFiniteCoordinate = (anchor: Anchor): boolean =>
  typeof anchor.lat === 'number' &&
  Number.isFinite(anchor.lat) &&
  typeof anchor.lng === 'number' &&
  Number.isFinite(anchor.lng)

export function entityIndexOf(entities: readonly Entity[]): ReadonlyMap<EntityId, Entity> {
  let index = entityIndexes.get(entities)
  if (!index) {
    const byId = new Map<EntityId, Entity>()
    for (const entity of entities) if (!byId.has(entity.id)) byId.set(entity.id, entity)
    index = byId
    entityIndexes.set(entities, index)
  }
  return index
}

export function locationIndexOf(anchors: readonly Anchor[]): ReadonlyMap<EntityId, Anchor> {
  let index = locationIndexes.get(anchors)
  if (!index) {
    const byEntityId = new Map<EntityId, Anchor>()
    for (const anchor of anchors) {
      if (anchor.kind !== 'location' || !isFiniteCoordinate(anchor)) continue
      if (!byEntityId.has(anchor.entityId)) byEntityId.set(anchor.entityId, anchor)
    }
    index = byEntityId
    locationIndexes.set(anchors, index)
  }
  return index
}
