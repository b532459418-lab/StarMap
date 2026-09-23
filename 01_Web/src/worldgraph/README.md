# StarMap Core — World Graph

`src/worldgraph/**` is **StarMap Core**: the environment-independent data model
and pure functions that everything else in StarMap is built on. It is licensed
under [MIT](../../../LICENSE) like the rest of this repository, and it stays MIT.
The product editions that build on it are described in
[docs/editions.md](../../../docs/editions.md).

## What is in here

| File | Role |
| --- | --- |
| `types.ts` | World Graph Core Model: `Entity`, `LayerMembership`, `Anchor`, `Relation`, `WorldGraphSnapshot`, and the id / enum-like string types (`LayerId`, `EntityType`, `RelationType`, `AnchorPrecision`, `Visibility`, `RelationProvenance`). |
| `layers.ts` | Layer Registry: `LayerDefinition` and the read-only `officialLayers` list (`travel`, `want_to_go`). Icons are stored as lucide icon *names*, not components, so Core never depends on React. |
| `slug.ts` | `slugify()`, the single slug rule shared by want-to-go entity ids and the same-place merge key in `query.ts`. The `.mjs` copies in `scripts/want-to-go-store.mjs` and `scripts/local-editor-plugin.mjs` must stay identical. |
| `snapshot.ts` | `mergeWorldGraphSnapshots()` combines several adapter outputs into one snapshot (first one wins on duplicate ids; memberships are keyed by `(entityId, layerId)`), plus `emptyWorldGraphSnapshot()`. |
| `query.ts` | Layer query: `queryVisiblePlaces()` turns a snapshot and the visible layer ids into the places and route segments the map renders. Each layer decides which place subtypes it draws, and a non-travel city that matches a visible travel city is merged into it (the heart badge). |
| `adapters/travel.ts` | Travel adapter: `travelToWorldGraph()` projects already-loaded travel domain objects (countries, cities, journey days, routes) into a `WorldGraphSnapshot`, plus the id helpers `countryEntityId`, `cityEntityId`, `journeyEntityId`, `relationId`, `sourcedRelationId`, `anchorId`. Pure and deterministic; `options.now` is required. |
| `adapters/wantToGo.ts` | Want to Go adapter: `parseWantToGoFile()` turns the contents of `want-to-go.local.json` (or the tracked sample) into items without throwing, dropping bad entries with a readable problem; `wantToGoToWorldGraph()` projects the items into a snapshot; `wantToGoEntityId()` builds `place:wtg:<CC>:<slug>` ids. Hidden items stay in the snapshot, marked on their membership. |
| `adapters/plannedRecords.ts` | Planned records adapter: `plannedRecordsToWorldGraph()` projects travel records with `status: planned` into read-only Want to Go entries; `plannedEntityId()` builds their ids. |
| `adapters/travel.fixture.ts` | Hand-written fixture: the known output of `travelAtlas.ts` for the tracked `travel-map.sample.json`, shared by `adapters/travel.test.ts` and `query.parity.test.ts`. Not a test file and never imported by application code. |
| `adapters/travel.test.ts` | Unit tests for the travel adapter, including the test that pins `travel.fixture.ts` back to the tracked sample JSON. |
| `adapters/wantToGo.test.ts` | Unit tests for want-to-go parsing, ids, and projection. |
| `adapters/plannedRecords.test.ts` | Unit tests for the planned records adapter. |
| `snapshot.test.ts` | Unit tests for snapshot merging. |
| `query.test.ts` | Unit tests for the layer query rules on small hand-written snapshots, including same-place merging. |
| `query.parity.test.ts` | Parity test: on the sample data, `queryVisiblePlaces()` produces exactly what the map computed before the layer query existed (a verbatim copy of that legacy logic lives only in this file). |
| `slug.test.ts` | Unit tests for `slugify()`. |

Run the tests with `npm test` from `01_Web/` (plain `node --test`, no bundler).

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
3. `adapters/travel.ts` — `travelToWorldGraph` and the id helpers.
4. `snapshot.ts` — `mergeWorldGraphSnapshots`, the way adapter outputs are
   combined.
5. `query.ts` — `queryVisiblePlaces`, the layer query every renderer reads.
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
hand-written (the existing test explains why importing `travelAtlas.ts` is not
an option) and pin them back to the tracked sample data where possible.
