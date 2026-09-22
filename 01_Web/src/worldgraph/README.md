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
| `adapters/travel.ts` | Travel adapter: `travelToWorldGraph()` projects already-loaded travel domain objects (countries, cities, journey days, routes) into a `WorldGraphSnapshot`, plus the id helpers `countryEntityId`, `cityEntityId`, `journeyEntityId`, `relationId`, `sourcedRelationId`, `anchorId`. Pure and deterministic; `options.now` is required. |
| `adapters/travel.test.ts` | Unit tests. Run with `npm test` from `01_Web/` (plain `node --test`, no bundler). |

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
4. The adapter interface itself (Local adapter here, Cloud adapter elsewhere),
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
