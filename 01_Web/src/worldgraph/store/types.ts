/** RD-08 G1: versioned, experimental logical store. Not an App persistence API
 * or a published SDK. Registry IDs are open; fact IDs retain RFC-LOC-1 UUIDv7.
 * Core has no filesystem, clock, randomness, Provider, or permission authority.
 */
import type { LocalizedText } from '../localizedText.ts'
import type { AnchorPrecision, Visibility } from '../types.ts'

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject
export interface JsonObject { readonly [key: string]: JsonValue }
export type ReadonlyTitle = {
  readonly names: Readonly<LocalizedText['names']>
  readonly originalLanguage?: string
}
export interface RawDates {
  readonly startDate?: JsonValue
  readonly endDate?: JsonValue
  readonly year?: JsonValue
}
/** Keep malformed/partial evidence verbatim. Quality is derived using RD-04. */
export interface StoredDates { readonly raw: RawDates }
export interface SourceRef {
  readonly sourceId: string
  readonly recordId: string
  readonly evidenceIds: readonly string[]
  readonly reviewId?: string
}
export interface StoreRow {
  readonly id: string
  readonly revision: number
  /** Opaque, JSON-only preservation lane. Never interpreted as a reference or capability. */
  readonly extensions?: JsonObject
}
export interface SourceDefinition extends StoreRow {
  readonly title: ReadonlyTitle
  readonly origin: 'user' | 'import' | 'rule' | 'ai'
}
export interface Evidence extends StoreRow {
  readonly sourceId: string
  readonly recordId: string
  readonly attributes: JsonObject
}
export interface ReviewReceipt extends StoreRow {
  readonly proposalId: string
  readonly sourceId: string
  readonly acceptedAt: string
}
export interface FieldDefinition {
  readonly key: string
  readonly kind: 'text' | 'number' | 'boolean' | 'date' | 'date_evidence' | 'entity_ref' | 'asset_ref'
  readonly required?: boolean
  readonly min?: number
  readonly max?: number
}
export interface EntityTypeDefinition extends StoreRow {
  readonly title: ReadonlyTitle
  readonly schemaVersion: 1
  readonly fields: readonly FieldDefinition[]
}
export interface LayerDefinition extends StoreRow {
  readonly title: ReadonlyTitle
  readonly schemaVersion: 1
  readonly acceptedEntityTypes: readonly string[]
  readonly entryFields: readonly FieldDefinition[]
  readonly systemKey?: string
}
export interface StoreEntity extends StoreRow {
  readonly typeId: string
  readonly title: ReadonlyTitle
  readonly fields: JsonObject
  readonly source: SourceRef
  readonly visibility: Visibility
}
export interface LayerEntry extends StoreRow {
  readonly layerId: string
  readonly entityId: string
  readonly fields: JsonObject
  readonly source: SourceRef
  readonly createdAt: string
  readonly updatedAt: string
}
export interface RelationTypeDefinition extends StoreRow {
  readonly title: ReadonlyTitle
  readonly fromTypes: readonly string[]
  readonly toTypes: readonly string[]
  readonly fields: readonly FieldDefinition[]
  readonly schemaVersion: 1
}
export interface StoreRelation extends StoreRow {
  readonly typeId: string
  readonly fromEntityId: string
  readonly toEntityId: string
  readonly source: SourceRef
  readonly fields: JsonObject
}
interface AnchorBase extends StoreRow {
  readonly entityId: string
  readonly source: SourceRef
  readonly precision: AnchorPrecision
  readonly visibility?: Visibility
}
export type StoreAnchor = AnchorBase & (
  | { readonly kind: 'location'; readonly lat: number; readonly lng: number; readonly approximate?: boolean; readonly altitude?: number }
  | { readonly kind: 'time'; readonly date: StoredDates }
)
/** References assets, never raw paths or media bytes. Runtime resolves IDs. */
export interface AssetReference extends StoreRow {
  readonly source: SourceRef
  readonly attributes: JsonObject
}
/** Retains ORIGINAL record adjacency, independent of filters or coordinates. */
export interface EntrySequence extends StoreRow {
  readonly entityId: string
  readonly entryIds: readonly string[]
  readonly source: SourceRef
}
export interface ViewState extends StoreRow {
  readonly layerId: string
  readonly orderedEntryIds: readonly string[]
  readonly hiddenEntryIds: readonly string[]
}
export interface StoreTables {
  readonly sources: readonly SourceDefinition[]
  readonly evidence: readonly Evidence[]
  readonly reviews: readonly ReviewReceipt[]
  readonly entityTypes: readonly EntityTypeDefinition[]
  readonly layers: readonly LayerDefinition[]
  readonly entities: readonly StoreEntity[]
  readonly entries: readonly LayerEntry[]
  readonly relationTypes: readonly RelationTypeDefinition[]
  readonly relations: readonly StoreRelation[]
  readonly anchors: readonly StoreAnchor[]
  readonly assets: readonly AssetReference[]
  readonly sequences: readonly EntrySequence[]
  readonly viewStates: readonly ViewState[]
}
export type StoreTable = keyof StoreTables
export type AnyStoreRow = StoreTables[StoreTable][number]
export interface WorldStore extends StoreTables {
  readonly format: 'starmap.world-store'
  readonly formatVersion: 1
  readonly revision: number
}
/** Trusted host policy, not a role supplied by records. Default denies system keys. */
export interface StorePolicy {
  readonly officialLayers?: Readonly<Record<string, string>>
}
export type StoreCommand =
  | { readonly op: 'create'; readonly table: StoreTable; readonly value: AnyStoreRow }
  | { readonly op: 'update'; readonly table: StoreTable; readonly id: string; readonly expectedRevision: number; readonly value: AnyStoreRow }
  | { readonly op: 'remove'; readonly table: StoreTable; readonly id: string; readonly expectedRevision: number }

/** Pending proposals live outside WorldStore and therefore outside fact queries. */
export interface Proposal {
  readonly id: string
  readonly sourceId: string
  readonly evidenceIds: readonly string[]
  readonly createdAt: string
  readonly baseRevision: number
  readonly reason: string
  readonly commands: readonly StoreCommand[]
  readonly status: 'pending' | 'accepted' | 'rejected'
}
