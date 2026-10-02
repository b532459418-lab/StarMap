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
| `snapshot.ts` | `mergeWorldGraphSnapshots()` combines several adapter outputs into one snapshot (first one wins on duplicate ids; memberships are keyed by `(entityId, layerId, recordId ?? '')`), plus `emptyWorldGraphSnapshot()`. |
| `query.ts` | Layer query: `queryVisiblePlaces()` turns a snapshot and the visible layer ids into the places and route segments the map renders. Each layer decides which place subtypes it draws. Same-place merging (FR-MR-5) is by identity: an entity with visible memberships in several layers is one marker listing those layers (travel plus want-to-go is the heart badge), with the visible record ids per layer in `recordIds`. |
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

- React components, hooks, CSS, browser storage, or anything that touches
  `window`. Example: `src/data/layerVisibility.ts` reads `localStorage`, so it
  lives in `src/data/`, not here, even though it only wraps `officialLayers`.
- Loading, parsing, or persisting files. Adapters receive loaded objects.
- Runtime registration of custom layers. `officialLayers` is intentionally a
  read-only array; custom layers are a later milestone.
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
