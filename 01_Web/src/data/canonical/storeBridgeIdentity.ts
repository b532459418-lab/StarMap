/** G2 experimental, in-memory allocation ledger. The host supplies UUIDs and
 * persists the returned ledger later; this module never reads/writes a file. */
import { freezeCopy, opaqueId, reject, shape, validateJson } from '../../worldgraph/store/schema.ts'
import { isUuidV7 } from './uuidv7.ts'

export interface BridgeIdentity {
  readonly kind: 'entry' | 'journey' | 'media'
  readonly sourceId: string
  readonly recordId: string
  readonly id: string
}
export interface BridgeManifest {
  readonly format: 'starmap.v2-store-identities'
  readonly version: 1
  readonly identities: readonly BridgeIdentity[]
}
export const identityKey = (row: Pick<BridgeIdentity, 'kind' | 'sourceId' | 'recordId'>): string =>
  JSON.stringify([row.kind, row.sourceId, row.recordId])

export function readBridgeManifest(value: unknown): BridgeManifest {
  validateJson(value)
  shape(value, ['format', 'version', 'identities'])
  if (value.format !== 'starmap.v2-store-identities' || value.version !== 1 || !Array.isArray(value.identities)) reject('E_BRIDGE_MANIFEST', '$.manifest')
  const keys = new Set<string>(), ids = new Set<string>()
  for (const row of value.identities) {
    shape(row, ['kind', 'sourceId', 'recordId', 'id'])
    if (!['entry', 'journey', 'media'].includes(row.kind as string)) reject('E_BRIDGE_MANIFEST', '$.manifest.kind')
    opaqueId(row.sourceId, '$.manifest.sourceId'); opaqueId(row.recordId, '$.manifest.recordId')
    if (typeof row.id !== 'string' || !isUuidV7(row.id) || row.id !== row.id.toLowerCase()) reject('E_UUID7', '$.manifest.id')
    const key = identityKey(row as unknown as BridgeIdentity)
    if (keys.has(key) || ids.has(row.id)) reject('E_BRIDGE_ID_COLLISION', '$.manifest')
    keys.add(key); ids.add(row.id)
  }
  return freezeCopy(value as unknown as BridgeManifest)
}

export function bridgeAllocator(previous: BridgeManifest | undefined, placeIds: readonly string[], allocateId: () => string) {
  const identities = [...(previous ? readBridgeManifest(previous).identities : [])]
  const byKey = new Map(identities.map(row => [identityKey(row), row.id]))
  const used = new Set(placeIds)
  for (const row of identities) {
    if (used.has(row.id)) reject('E_BRIDGE_ID_COLLISION', '$.manifest')
    used.add(row.id)
  }
  return {
    get(kind: BridgeIdentity['kind'], sourceId: string, recordId: string): string {
      opaqueId(recordId, '$.source.recordId')
      const key = identityKey({ kind, sourceId, recordId }), existing = byKey.get(key)
      if (existing) return existing
      const id = allocateId()
      if (typeof id !== 'string' || !isUuidV7(id) || id !== id.toLowerCase()) reject('E_UUID7', '$.allocatedId')
      if (used.has(id)) reject('E_BRIDGE_ID_COLLISION', '$.allocatedId')
      used.add(id); byKey.set(key, id); identities.push({ kind, sourceId, recordId, id })
      return id
    },
    finish(): BridgeManifest {
      // Keep absent identities as tombstones so reappearance cannot steal an ID.
      return readBridgeManifest({ format: 'starmap.v2-store-identities', version: 1, identities })
    },
  }
}
