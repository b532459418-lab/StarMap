# StarMap Core — World Graph

`src/worldgraph/**` is **StarMap Core**: the environment-independent data model
and pure functions that everything else in StarMap is built on. It is licensed
under [MIT](../../../LICENSE) like the rest of this repository, and it stays MIT.
The product editions that build on it are described in
[docs/editions.md](../../../docs/editions.md).

## What is in here

| File | Role |
| --- | --- |
| `types.ts` | World Graph Core Model: `Entity`, `LayerMembership`, `Anchor`, `Relation`, `WorldGraphSnapshot`, and the id / enum-like string types (`LayerId`, `EntityType`, `RelationType`, `AnchorPrecision`, `Visibility`, `RelationProvenance`). A membership may carry the `recordId` of the record behind it (a want-to-go item or a planned travel record), so one entity can have several memberships in the same layer. |
| `localizedText.ts` | `LanguageTag`, `LocalizedText`, and pure name helpers: `resolveName(text, uiLocale)`, `originalNameSubtitle(text, uiLocale)`, `searchableNames(text)`, and `copyLocalizedText(text)`. Titles retain all registry names and an optional original language; resolution happens when displaying or sorting. |
| `layers.ts` | Layer Registry: `LayerDefinition` and the read-only `officialLayers` list (`travel`, `want_to_go`). Display labels are stored as translation keys; icons are stored as lucide icon *names*. Core does not resolve either into UI objects. |
| `slug.ts` | `slugify()`, the single slug rule. Core itself no longer uses it (since RFC-LOC-1 Core-A, entity ids are registry place ids and the map merges by identity); it is kept for matching and search: the App's place resolver for V2 writes (`src/data/canonical/placeResolver.ts`, which imports `slug.ts` directly) and the country search in `scripts/local-editor-plugin.mjs`, whose `.mjs` copy must stay identical. The former copy in `scripts/want-to-go-store.mjs` was removed with that legacy write module (RFC-LOC-1 PR5). |
| `timeFilter.ts` | RD-04 calendar helpers: validate and normalize query bounds, create equivalent year ranges, classify injected raw dates, and return definite / uncertain / excluded matches. Complete dates use closed-interval overlap; trusted year-only dates require full-year coverage for a definite hit. App injects raw context and per-layer conditions into map and Journey projections; Core does not read browser preferences. |
| `timeFilter.test.ts` | Calendar and matching tests covering leap years, equivalent year/custom intervals, partial and invalid dates, reliable exclusions, open bounds and immutable inputs. |
| `recordIdentity.ts` | Source-aware opaque record references. Snapshot merging, Collection deduplication and UI keys distinguish ordinary want-to-go items from planned records even when their IDs coincide. Unknown sources retain first-wins behavior. |
| `timeQuery.ts` | Evaluates injected raw-record date evidence independently per layer, preserving source identity and excluding hidden browse candidates. The app derives this context before filtering records or coordinates. |
| `snapshot.ts` | `mergeWorldGraphSnapshots()` combines several adapter outputs into one snapshot (first one wins on duplicate ids; memberships are keyed by entity, layer, recognized source kind and record ID), plus `emptyWorldGraphSnapshot()`. |
| `query.ts` | Layer query: `queryVisiblePlaces()` turns a snapshot and the visible layer ids into the places and route segments the map renders. Each layer decides which place subtypes it draws. Same-place merging (FR-MR-5) is by identity: an entity with visible memberships in several layers is one marker listing those layers (travel plus want-to-go is the heart badge), with the visible record ids per layer in `recordIds`. |
| `queryTime.test.ts`, `timeQuery.test.ts`, `recordIdentity.test.ts` | Source collisions, independent layer conditions, exact original route endpoints, no bridging across omitted visits, uncertain-date inclusion, clear-to-baseline behavior and matched detail selection. App supplies the optional time-query input; absent date bounds continue the existing all-time path. |
| `collection.ts` | Collection query: `queryCollection()` lists every member of one layer, one row per record with its `recordId` (hidden and coordinate-less entries included, layer visibility ignored; title, country code and location come from the place entity, record fields from the membership) for the Collection view; `filterCollection()` applies the text search, visible / hidden filter, and recent / name / country sort. |
| `adapters/places.ts` | Places adapter: `placesToWorldGraph()` builds the place entities from the place registry (`PlaceInput`, mapped by the app), one per place with the registry id as entity id, plus each place's location anchor and `part_of` relation. It is the only adapter that builds place entities, so a place referenced by several adapters is one entity. `placeEntity()` and `placeLocationAnchor()` build the two parts. |
| `adapters/travel.ts` | Travel adapter: `travelToWorldGraph()` projects already-loaded travel domain objects into the travel layer: travel memberships for countries and cities (keyed by place id; `accent` and a country's `cityIds` sit on the membership), journey-day entities with time anchors, and `visited` / `related_to` relations. Id helpers `journeyEntityId`, `relationId`, `sourcedRelationId`, `anchorId`. Pure and deterministic; `options.now` is required. |
| `adapters/wantToGo.ts` | Want to Go adapter: `wantToGoToWorldGraph()` turns want-to-go items (`WantToGoInput`: id, place id, dates and flags, as read and validated by the app's V2 Reader) into memberships of the place entity, one per item, with the item id as `recordId`. Hidden items stay in the snapshot, marked on their membership. |
| `adapters/plannedRecords.ts` | Planned records adapter: `plannedRecordsToWorldGraph()` turns travel records with `status: planned` (`PlannedRecordInput`, selected by the app) into read-only Want to Go memberships of their city's place entity, with the record id as `recordId`. |
| `adapters/travel.fixture.ts` | Hand-written fixture: travel domain objects (the known output of the old `travelAtlas.ts` for a former neutral legacy-format sample, frozen since RFC-LOC-1 Core-A retired that file) and `placesOf()` / `samplePlaces()`, their registry places. Shared by `adapters/travel.test.ts` and `src/data/derive/baseline.test.ts`. Not a test file and never imported by application code. |
| `adapters/places.test.ts` | Unit tests for the places adapter. |
| `adapters/travel.test.ts` | Unit tests for the travel adapter, including its merge with the places snapshot. |
| `adapters/wantToGo.test.ts` | Unit tests for the want-to-go adapter. |
| `adapters/plannedRecords.test.ts` | Unit tests for the planned records adapter. |
| `snapshot.test.ts` | Unit tests for snapshot merging. |
| `query.test.ts` | Unit tests for the layer query rules on small hand-written snapshots, plus identity merging over the four real adapters (one entity per place across adapters, one marker per place, names no longer merge). |
| `collection.test.ts` | Unit tests for the Collection query, search, filters, and sorts, plus integration cases over the places, want-to-go and planned adapters. |
| `slug.test.ts` | Unit tests for `slugify()`. |

Run the tests with `npm test` from `01_Web/` (plain `node --test`, no bundler).

## Experimental logical store (RD-08 G1)

`store/` adds a versioned **experimental** Entity / Layer / LayerEntry contract
alongside the existing V0.4 graph. The App still uses the V2 adapters and original
two-layer queries. This is not a storage migration, a stable SDK, or a custom-layer UI.

| File | Responsibility |
| --- | --- |
| `store/types.ts` | Deeply readonly JSON-shaped definitions, facts, source/evidence/review references, anchors, relations, assets, original entry sequences and view state; pending proposals live outside the fact store. |
| `store/schema.ts` | Version 1 runtime shape and semantic validation, UUIDv7 entity/entry IDs, registered types, field constraints, source identities, closed references, safe JSON and immutable copies. |
| `store/commands.ts` | Explicit in-memory command batches with world/object revision checks; reject conflicts, schema reinterpretation and deletion with dangling references. Removing the last entry preserves its entity. |
| `store/query.ts` | Complete management rows, RD-04 classification of verbatim raw dates, and original adjacency without bridging a filtered middle entry. |
| `store/conflicts.ts` | Merge preflight: structural duplicates are idempotent; same-ID different payloads return conflicts and no partial command plan. |
| `store/proposals.ts` | Separate proposal validation and explicit review acceptance/rejection. Accepted AI facts retain their source, evidence and review receipt. |

Layer/type IDs are open registry IDs. Entity/entry IDs are injected UUIDv7 values;
Core does not generate them. `sourceRecordKey` / `entryIdentityKey` preserve opaque
source record IDs and distinguish colliding planned/saved sources. Persisting a
stable source-to-entry allocation manifest belongs to the forthcoming V2 bridge.

`date` fields require complete calendar dates. `date_evidence` retains raw
start/end/year values, including historical invalid or partial values; quality is
derived with the existing RD-04 classifier, never repaired. Opaque `extensions`
preserve additional JSON source fields without treating them as references or
capabilities. Field definitions cannot contain executable code.

System keys require an explicit trusted host binding. Visibility fields and
review receipts are consistency/audit data, **not authorization enforcement**.
The host must authorize access and review decisions. A proposed AI change cannot
register new sources/types or fabricate receipts through ordinary commands.

These functions make defensive immutable copies for small contract workloads.
They do not implement IO, disk transactions, multi-process concurrency,
authentication, schema migrations, persistent proposal ledgers, external import
history policy, or performance guarantees. New review receipts and nonzero
revision history require a later explicit import policy. A Repository must
commit reviewed facts and proposal status durably together; in-memory acceptance
does not prove restart recovery or network idempotency. Backup/restore scope is
unchanged. Package extraction remains gated on the overall RFC being accepted.

Focused verification from `01_Web/`:

```powershell
node --test --test-isolation=none src/worldgraph/store/*.test.ts
```

## Names and UI locale

Entity, place-input, map-query and Collection titles use `LocalizedText`:
`{ names: Record<LanguageTag, string>, originalLanguage?: LanguageTag }`.
Place titles copy the registry values without inserting fallback names. Journey-day
titles have an unknown language and use `names.und`; an absent title has empty names.
Queries copy the title and its nested names object instead of sharing references.

`resolveName` maximizes BCP 47 tags with `Intl.Locale`, then chooses an exact
language/script/region match, a language/script match, or the other Chinese script.
If none matches, Chinese, Japanese and Korean interfaces prefer the original name
before English; other interfaces prefer English before the original name. The
last fallback is any nonempty name in tag code-point order. Invalid tags and `und`
only participate in that last fallback. Empty names resolve to an empty string.

The original-name subtitle is present only when it exists and differs from the
resolved title. Migrated places without `originalLanguage` therefore have no
Collection subtitle; their English names remain searchable. Collection searches
all names, country code and note with NFKC normalization and case folding.
`queryCollection(snapshot, layerId, uiLocale)` and
`filterCollection(entries, filter, uiLocale)` both require the UI locale. Name
comparisons use `Intl.Collator(uiLocale)` with entity id and then record id as
stable tie breakers; recent and country sorts use the same name comparator.

The App supplies the current UI locale through its i18next provider (Simplified
Chinese or English). Map labels, Cesium entity names, and Collection follow it.
Official layer definitions carry a namespaced `labelKey` (`layer:travel` or
`layer:wantToGo`), rather than a `{ zh, en }` label object. The App resolves it
with `t(layer.labelKey)` using its `layer` translation resources. Core stores
only the key and has no i18next dependency; language changes do not change
layer ids, order, visibility defaults, accents, icons or projection rules.
Deterministic data baselines always use `DEFAULT_UI_LOCALE` (Simplified Chinese),
independent of browser preferences. Other domain fields and interface wording
remain outside this Core name contract; their UI translation is being migrated
in stages.

## The boundary, and why it is enforced

Core may be consumed by the UI, the local data layer, and any future adapter.
It must never depend on them. ESLint enforces this (see the `FR-MOD` block at
the end of `eslint.config.js`); the rules mirror decision D25 of the product
strategy and are not to be relaxed without changing that decision first.

Inside `src/worldgraph/**` you must not:

- import `src/components/**` (presentation layer), statically or dynamically;
- import `src/data/travelAtlas.ts` (application singleton that pulls in the
  Vite virtual module `virtual:starmap-private-data` and `import.meta.env`);
- use `import.meta` or `import.meta.env` in any form.

Anything Core needs from the outside is passed in as a parameter. The only
inbound dependency today is `import type` of the travel domain types in
`src/types/travel.ts`, which is type-only and erased at build time.

Two more rules keep Core runnable outside Vite:

- **Erasable-only TypeScript.** Use `type` and `interface`; no `enum`,
  `namespace`, or parameter properties. Node's type stripping and the
  `erasableSyntaxOnly` compiler option both reject anything else.
- **No I/O, no clocks, no module-level state.** Adapters are pure functions of
  their inputs. Timestamps come from `options.now`; nothing reads `Date.now()`.

## Stability

The World Graph Core Model RFC is **not final**. Until it is, the types here are
a PRD-level draft (StarMap V0.4 Layer Engine PRD §6) and may change between
minor versions. Do not treat them as a stable public contract yet, and do not
copy them into other packages.

When the RFC is accepted, the plan is:

```text
01_Web/src/worldgraph/**   →   packages/core/   →   @starmap/core (npm)
```

The lint boundary above exists so that this move is a file move, not a
refactor. Do not start the move before the RFC is final; there is no second
consumer yet, and an early extraction only adds cost.

Public API candidates for that package, in the order they are likely to
stabilize:

1. `types.ts` — the five core objects and their id / enum types.
2. `layers.ts` — `LayerDefinition` and the official layer registry.
3. `adapters/places.ts` and `adapters/travel.ts` — `placesToWorldGraph`, `travelToWorldGraph` and the id helpers.
4. `snapshot.ts` — `mergeWorldGraphSnapshots`, the way adapter outputs are
   combined.
5. `query.ts` — `queryVisiblePlaces`, the layer query every renderer reads.
   `collection.ts` — `queryCollection` / `filterCollection`, the list-view
   counterpart that ignores layer visibility.
6. The adapter interface itself (Local adapter here, Cloud adapter elsewhere),
   once it exists as code rather than as a diagram.

## What does *not* belong here

RD-08 G2's experimental V2 bridge lives in the App's pure data layer:
`src/data/canonical/storeBridge.ts`, `storeBridgeIdentity.ts`, and
`storeBridgeProjection.ts`. It accepts complete validated V2 objects, builds
the isolated Store, and keeps a caller-owned allocation ledger and opaque
compatibility metadata. Its diagnostic projection reconstructs the five JSON
values before using the existing pure App projectors; the separate sequence
projection reads Store entries directly. Neither is an active App loader or
writer. File bytes, media resolution, persistence, authorization, and any
planned-to-visited write transition remain host responsibilities for later
phases. Core must not import that bridge or the Canonical domain types.

RD-08 G3's Node-only persistence foundation is separately implemented in
`scripts/world-store-repository.mjs`. Its experimental SQLite transaction stores
the world, G2 allocation ledger, proposals, retired IDs and operation receipt
together. Repository versions also advance on proposal-only/audit saves;
Core world revisions advance on fact changes. Commit acknowledgement loss
requires operation discovery; the repository never automatically retries.
Core stays pure, and the current App/V2 writer does not use this repository.
The tests require Node 24 with `node:sqlite` and use temporary synthetic databases
plus bounded, terminated child workers. Device power-loss, hostile filesystem
changes, advanced history import and schema upgrades are not
established by these tests.

G3b's isolated `scripts/world-store-backup.mjs` uses SQLite `VACUUM INTO` for a
consistent database snapshot, then validates and seals a new directory. Restore
copies a verified package into another new directory, preserving facts, allocation
identities, proposal states, retired IDs and all operation receipts. It never
overwrites an existing destination. Completion/discovery helpers reject partial
or corrupt packages. A restore marker describes the initial restored snapshot;
later application writes legitimately invalidate that snapshot checksum. These
packages contain database metadata and asset references, not external media,
V2 files or configuration. The current library-backup CLI retains its V2/media
scope. This prototype trusts caller-owned directories and has no App endpoint,
schema migration, cryptographic authenticity or device power-loss guarantee.

G3b history intake now has a read-only preflight in
`scripts/world-store-history-preview.mjs`. It binds a validated backup to a
host-supplied source label and exact byte digest, compares record/identity/
proposal/retired-ID conflicts, and checks the merged semantics for fresh-only
input. Every report has `executable: false` and no commands. Refresh validation
binds the full target state, package and entire report; it does not hold a write
lock. Foreign receipts stay in their original backup package. Existing receipts
store commit summaries and request hashes, not every prior value or request body;
therefore this evidence is a validated current snapshot, not a complete edit log.
Stable repository identity, foreign archives, persisted import decisions and
schema upgrades remain later work. No App, repository writes or schema changes
are introduced by this preflight.

- React components, hooks, CSS, browser storage, or anything that touches
  `window`. Example: `src/data/layerVisibility.ts` reads `localStorage`, so it
  lives in `src/data/`, not here, even though it only wraps `officialLayers`.
- Loading, parsing, or persisting files. Adapters receive loaded objects.
- App runtime registration and custom-layer UI. `officialLayers` remains a
  read-only array for the current App; the separate experimental `store/`
  contract accepts data-defined registry rows without mutating that global list.
- Cloud, sync, sharing, or AI features. Those are separate editions; see
  [docs/editions.md](../../../docs/editions.md).

## Working in Core

```powershell
cd 01_Web
npm run lint     # includes the FR-MOD boundary rules
npm test         # node --test over src/**/*.test.ts
```

Every change to `types.ts` or an adapter needs a test. Keep test fixtures
hand-written (the existing tests explain why importing `travelAtlas.ts` is not
an option).
