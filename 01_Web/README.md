# StarMap Web Application

This directory contains the runnable React, TypeScript, Vite, and Cesium application.

## Setup

```powershell
npm ci
npm run dev:public
```

Open `http://127.0.0.1:5173/`. Codex uses 5173; the separate DSH mirror uses 5174.

## One Product, Two Runtime States

StarMap is one codebase, not separate public and editor editions:

- `npm run dev:personal` starts the **personal editing profile**. It loads only the external private layer, enables the loopback editor, and writes changes there with backups and atomic replacement.
- `npm run dev:public` starts the **public preview profile**. It loads only tracked neutral sample data and exposes no editor.
- `npm run build:public` creates the public static build. `npm run build:personal` creates a private build for an owner-controlled deployment and copies the external personal media into that build only.

Every person who clones the open-source project receives the same local editing capability. No DeepSeek Harness, chat-command relay, or AI service is required for deterministic edits. An Agent remains useful when a country, city, date, coordinate, media type, or privacy decision is uncertain, but the editor never guesses those values.

The official maintenance workspace keeps editor data in `StarMap/06_private/data/editor-state.local.json`; a standalone clone may set `STARMAP_PRIVATE_ROOT` or use its ignored `06_private/` fallback. This state records display order, hidden items, photo covers, and media order. Country creation uses one Chinese / English / ISO-code autocomplete field backed by the bundled country catalog, then derives the canonical names, code, flag, and map center from the selected result. City creation appears only after entering a country; the user enters a name and explicitly presses Search. With a personal Cesium token whose public scopes include `geocode`, the loopback editor queries Cesium ion first. It falls back to a country-filtered OpenStreetMap Nominatim lookup when ion is unavailable, has no result, or times out. Both providers derive bilingual names and coordinates from the selected result; manual latitude/longitude entry remains available when online lookup cannot identify the city. Dates remain explicit user input. Hiding is non-destructive: source records and Inbox originals remain untouched.

The editor separates two similar-looking recovery actions:

- **Undo this round** returns the current unsaved ordering and hide/show draft to the state that existed when the editor was opened. It does not erase previously saved data.
- **Restore hidden items** explicitly removes saved hide flags, writes that change to the ignored local state, and reloads the page. It still does not delete or reconstruct source records.

Local-editor errors use the compatible flat response `{ ok: false, error, code, params?, details? }`. The original `error` string and diagnostic `details` are preserved; the client translates known codes at display time. Permission, city-search and request-size refusals have explicit codes. Unknown system errors retain their original diagnostics under `E_UNEXPECTED`. The client accepts success only from a successful HTTP response with `ok: true`; an empty, unreadable or malformed response warns that the result may be unknown. Conversion retries require a reload after partial writes or unreadable responses. Media upload validation has explicit codes for empty/oversized files, invalid images, unusable names and panorama aspect ratios. Import execution failures include a language-neutral preflight/apply stage and preserve stdout/stderr in details; details alone never imply a blocked preflight. After import errors, check the Inbox and media list before repeating an upload or deletion. Writes are never automatically retried.

Online city lookup is explicit rather than autocomplete-on-every-keystroke. Each provider is limited to nine seconds, requests are cached in memory, and OpenStreetMap calls are serialized, country-filtered, visibly attributed, and follow the public [Nominatim usage policy](https://operations.osmfoundation.org/policies/nominatim/). Chinese Nominatim results accept exact names and equal-length simplified/traditional variants such as `波尔图` / `波爾圖`, while rejecting unrelated longer substring matches such as `赫本` inside another place name; retry with the local/English name or use manual coordinates when necessary. Cesium ion results may contain either a point or a bounding box; StarMap uses the box center when no point is supplied. Do not turn this path into bulk geocoding. The country catalog is supplied by the ODbL-licensed [`world-countries`](https://github.com/mledoze/countries) package and is used only by the loopback editor middleware, so it is not shipped in the public client bundle.

## Verification

```powershell
npm run lint
npm test
npm run build:public
npm run privacy:check
npm run release:check
```

`npm test` runs the World Graph Core unit tests with plain `node --test`; no bundler is involved. See [`src/worldgraph/README.md`](src/worldgraph/README.md).

## Public Sample and Private Data

StarMap has two data layers:

- `src/data/v2-sample/` is the tracked neutral North Atlantic demonstration used by a clean open-source clone: a five-city journey plus a Want to Go sample with three places (Nuuk, Tromsø, Akureyri). Akureyri is one place in both layers, so the public map shows the heart badge. The directory holds only the five V2 data files, which are maintained by hand (see [Edit the V2 sample](#edit-the-v2-sample)).
- `<private-root>/data/` is the external private layer containing the owner's countries, cities, routes, coordinates, display rules, Want to Go list, editor state, and media catalog. Its layout is described in [Private Data Format](#private-data-format).

The private layer is considered only in the explicit personal profile. Public preview and public build ignore it even when it exists; they, and forced sample mode (`VITE_TRAVEL_ATLAS_DATA_MODE=sample`, or `?data=sample` in development), read `src/data/v2-sample/`. Forced sample mode previews the public site: the local editor is off even in the personal profile, so the page renders exactly as in public mode, with no editing control, and nothing can be written to the private folder from it.

In the personal profile, Want to Go never falls back to the sample: sample items are not in the private file, so the editor could not hide them. When the private Want to Go file does not exist yet, the list is empty. The add entry and the Hide button are rendered only for private data, in addition to the existing development-only editor gate.

## Private Data Format

The personal profile, the local editor, and the scripts read and write only the V2 files in `<private-root>/data/v2/`. Every country and city is a place with a permanent id in `data/v2/places.local.json`; travel records, Want to Go items, editor state, and media refer to places by id. The files are `data/v2/places.local.json`, `travel-map.local.json`, `want-to-go.local.json`, `editor-state.local.json`, and `user-media.local.json`, plus the media importer's `data/v2/media-source-index.local.json`.

A new private folder starts with an empty map and the hint “还没有足迹，从添加第一个城市开始。”; nothing is copied from the sample. Do not edit the V2 files by hand; use the local editor or the media importer. `.bak` files, which every write keeps as the previous version, never count as data files.

### Legacy-format data

Private folders created before the V2 format hold `data/travel-map.local.json`, `want-to-go.local.json`, `editor-state.local.json`, and `user-media.local.json`, where countries and cities are identified by their names. StarMap no longer reads these files. When any of them exists and `data/v2/` has none of the five V2 files, the folder has not been migrated, and StarMap keeps `data/v2/` empty so the migration can still run:

- the personal profile shows a migration notice above the map;
- every local editor write is refused (HTTP 409, code `E_LEGACY_UNMIGRATED`) with the same instructions;
- `npm run media:check` and `npm run media:import` refuse to run (exit code 2).

StarMap never moves, rewrites, or migrates these files by itself. If you do not need the old data, move the four files out of `data/` and refresh the page; the folder then starts empty.

### Migrate legacy-format data

The current version no longer contains the migration tool. Commit `4fd32a9` is the last version that has it: check it out, migrate, and come back to the latest version. Run the npm commands from `01_Web/`; none of them changes the legacy files.

1. **Check out the migration version**: `git checkout 4fd32a9`.
2. **Install its dependencies**: `npm ci` in `01_Web/`.
3. **Dry run**: `npm run identity:check`, and read the report. It prints counts, errors, items that need a decision, and whether the migration can be applied (`canApply`). It also writes `data/migration/identity-manifest.local.json`, which fixes the new id of every place so later runs reuse it. Add `-- --report <file>` to write the full report, including place names, to a file inside the private folder or outside the repository. If the report lists items that need a decision (possible duplicate places, name or coordinate differences between a visited city and a Want to Go place), write each decision into `data/migration/identity-decisions.local.json` under the key the report shows, then run the dry run again until `canApply` is `true`.
4. **Apply**: `npm run identity:check -- --apply`. It writes the five V2 files to `data/v2/` and verifies them. It refuses while `data/v2/` already holds V2 files.
5. **Return to the latest version**: `git checkout main`, run `npm ci` again in `01_Web/`, and refresh the page.

A private folder without legacy data needs no migration. There is no switching back: StarMap reads only `data/v2/`.

After the migration the four legacy files are leftovers that StarMap does not read; keep or delete them. The same holds for `data/data-mode.local.json`, the data-mode marker written by earlier versions: it is ignored.

Media keep their catalog entries through the migration. The first media import after the migration gives every item a new id based on its file content, so ordering, hiding, and covers saved for the old ids no longer apply; the dry run reports how many items are affected.

### Edit the V2 sample

The five V2 files in `src/data/v2-sample/` are the only source of the public sample and are maintained by hand; no tool generates them. After editing them, run `npm run privacy:check`: it checks that the directory holds only these five files, that they pass the V2 validation, and that the sample stays neutral (`privacy_level` is `public-sample`, Want to Go ids start with `wtg_`, no hidden or editor-written items). New places need new UUIDv7 ids. `npm test` also pins the sample's derived baseline (`node scripts/baseline.mjs --sample`), so a deliberate change to the sample updates that lock in `src/data/canonical/derive.test.ts` too.

Run `npm run privacy:check` before every public release. See the [open-source privacy boundary](../03_Reference/TravelAtlas_open_source_privacy_boundary.md) for the boundary table and deployment options.

## Import Personal Media

Users can simply ask an Agent to read the StarMap rules and explain how to import their photos. The Agent starts with the short [Media Inbox README](../02_Assets/MediaInbox/README.md), checks that every item has a reliable existing country and city, and asks before proceeding whenever required information is missing or uncertain.

After real files follow the tracked template inside `<private-root>/MediaInbox/`, run:

```powershell
npm run media:check
npm run media:import
```

The first command is read-only and reports unresolved countries, cities, formats, or drone metadata. After a clean preflight, the second command preserves a local original copy and generates two WebP derivatives for every still image: a `640 px` thumbnail for city/sidebar/card surfaces and a `2400 px` preview for the photo viewer. Full-resolution photos and panoramas are requested only by explicit viewing actions. All three tiers use stable, hash-based paths inside the ignored local user library, and the ignored catalog records their dimensions. Restart the preview after importing.

Inbox source media must never be moved, renamed, overwritten, or deleted. Agents may create or update only the private control files `place.json`, `country.json`, and city-level `media.json`; `place.json` is normally written by StarMap itself. Supported still formats are optimized outside the Inbox by the importer, while unsupported formats still require a separate user-approved conversion step.

The importer resolves each country and city folder against the place registry (`place.json`, then a legacy `country.json`, then the folder name), writes `place.json` into folders it matched by name, and derives every media id and generated path from the file content alone. The [Media Inbox README](../02_Assets/MediaInbox/README.md) describes the rules.

See [`../03_Reference/TravelAtlas_media_import_protocol.md`](../03_Reference/TravelAtlas_media_import_protocol.md) for the complete user and Agent contract.

## Environment and Cesium ion

StarMap remains runnable without Cesium ion: when `VITE_CESIUM_ION_TOKEN` is empty, the app uses the bundled low-resolution Natural Earth II map. To enable online global imagery, the person who develops or deploys this copy of StarMap must use an app-specific token from their own Cesium ion account. Website visitors do not configure tokens, and a clean open-source clone never inherits the project author's token.

For personal development, copy `.env.example` to `<private-root>/config/.env.local` and enter the value there yourself. Create your own token at [Cesium ion Access Tokens](https://ion.cesium.com/tokens). An Agent may guide the setup, but it must never ask you to paste the complete token into chat or read it back. For production, configure `VITE_CESIUM_ION_TOKEN` in the hosting platform. Never commit or paste a real token into chat, source code, documentation, logs, screenshots, or examples.

A Vite client variable is excluded from Git but is still observable by users of the built website. Use separate development and production tokens, keep only the public `assets:read` permission and required assets, restrict the production token to the final Allowed URLs, monitor per-token usage, and rotate only the affected token when necessary. Both tokens consume the same ion account quota; separation provides control and diagnostics, not additional quota.

## Multiple Imagery Sources

StarMap uses Cesium as its 3D engine and can draw imagery from Cesium ion, Tianditu, or the bundled Natural Earth II fallback. Configure both online credentials in `<private-root>/config/.env.local` when needed, then choose the initial source with `VITE_MAP_SOURCE=auto|cesium|tianditu|local`. `auto` keeps the existing priority of Cesium, then Tianditu, then local fallback.

Tianditu is integrated through Cesium's WMTS imagery provider as an imagery base layer plus a Chinese annotation layer. The bottom map dock always shows a Layers button and all three source rows. Cesium and Tianditu use a steady green status light when their environment value is present and a red light when it is absent; the bundled local fallback is always green. Unconfigured online rows remain visible but disabled. The control stores the user's available selection in browser local storage and never asks for, displays, writes, or validates credential contents. Production deployments must define the selected variables before the static build.

## Public Interface Defaults

The public template uses the neutral `StarMap` identity. Its primary navigation contains Map, Journey and Collection, with a Chinese/English selector alongside it. The first supported browser language sets the initial interface language, falling back to English; a saved manual choice takes priority. The document language follows that choice. The center-bottom dock contains icon buttons for the compass, map layers, map-source selection, the labels overlay, City 3D, and version updates; the sidebar toggles sit outside the dock.

The public interface deliberately uses neutral copy that a new user can replace with their own identity.

## GitHub Release Updates

The official build checks `b532459418-lab/StarMap` by default. A fork can override the source with:

```text
VITE_GITHUB_REPOSITORY=your-name/your-fork
```

The app compares its `package.json` version with the latest GitHub Release at most once every 12 hours. An unseen newer Release gives the bottom update button a breathing-light signal. Its full update page contains the update guide, Release announcement, version notes, and a guarded AI-update prompt the user can copy. It never downloads code or overwrites local files automatically.

The update button is a reversible page control: its first click opens the update page, and its next click returns to the exact Map or Journey page that was active before.

For each public update, bump the package version, create a matching semantic-version Release such as `v0.2.0`, and describe any migration steps in the Release notes. AI-assisted updates must merge around ignored environment files, private overlays, personal media, and uncommitted work, then run the project's required checks.

## Architecture

- `src/worldgraph/` is StarMap Core: the World Graph model, Layer Registry, and adapters. It is environment-independent and lint-enforced; see [`src/worldgraph/README.md`](src/worldgraph/README.md).
- `src/components/CesiumAtlasGlobe.tsx` is the primary map implementation.
- `src/components/CollectionPage.tsx` is the Collection view: every Want to Go entry, including hidden and coordinate-less ones, with search, filters, sorting, note editing, hide / restore / delete, and View on map.
- `src/worldgraph/collection.ts` is the Core list query behind it (`queryCollection` / `filterCollection`); unlike the map query it ignores layer visibility and keeps hidden entries.
- `src/extensions/` holds the Google imagery, labels, and Photorealistic 3D Tiles integrations; see [`src/extensions/README.md`](src/extensions/README.md).
- `src/components/AtlasGlobe.tsx` is the frozen legacy react-globe implementation.
- `src/data/rawInputs.ts` chooses what the app reads: the tracked V2 sample in public and forced sample mode, otherwise the private V2 files injected by the profile-specific virtual module.
- `src/data/travelAtlas.ts` exports the travel data derived from those inputs.
- `scripts/legacy-data.mjs` decides whether a private folder still holds legacy-format data that has not been migrated (the migration itself runs on commit `4fd32a9`, see [Migrate legacy-format data](#migrate-legacy-format-data)).
- `scripts/baseline.mjs` (`npm run baseline`) writes the derived baseline of the public V2 sample (`--sample`) or of the private `data/v2/` as byte-comparable JSON, and compares two baselines (`--compare`).
- `src/data/wantToGo.ts` chooses the Want to Go source (tracked sample, private file, or none) and parses it through the Core adapter.
- `src/data/worldGraph.ts` merges the travel, want-to-go, and planned-record snapshots into the single World Graph snapshot that the map queries.
- `src/data/mediaCatalog.ts` receives personal media only in personal mode; `src/data/droneMedia.ts` contains no built-in user media.
- `scripts/private-profile.mjs` resolves the external private root without reading or printing secrets.
- `scripts/local-editor-plugin.mjs` provides the loopback-only editor in personal development and injects no private data in public mode; `scripts/private-data-module.mjs` holds its virtual-module and file-watch rules.
- `scripts/v2-editor-store.mjs` and `scripts/v2-media-store.mjs` read and write `data/v2/` behind the editor's write endpoints; the rules themselves, including Mark as visited, are pure functions in `src/data/v2write/` and `src/data/v2media/`.
- `scripts/import-media.mjs` (`npm run media:check`, `npm run media:import`) runs the media importer in `scripts/v2-media-import.mjs`.
- `scripts/json-file.mjs` holds the JSON read, backup, and atomic-write helpers shared by the editor, the importer, and the migration tool.
- `scripts/public-release-check.mjs` rebuilds a clean Git archive in the OS temporary directory, so public-release verification cannot see the private layer.
- Project-level rules, contribution guide, and edition boundaries live one directory above this web workspace (`AGENTS.md`, `CONTRIBUTING.md`, `docs/editions.md`).

## Documentation

- Public guide: [`../README.md`](../README.md)
- Chinese guide: [`../README.zh.md`](../README.zh.md)
- Web Agent rules: [`AGENTS.md`](AGENTS.md)
- Media import protocol: [`../03_Reference/TravelAtlas_media_import_protocol.md`](../03_Reference/TravelAtlas_media_import_protocol.md)
- Open-source privacy boundary: [`../03_Reference/TravelAtlas_open_source_privacy_boundary.md`](../03_Reference/TravelAtlas_open_source_privacy_boundary.md)
