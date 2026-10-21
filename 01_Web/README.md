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
- `npm run build:public` creates the public static build. `npm run build:personal` creates a private build for an owner-controlled deployment. Its data leaves out hidden content and everything only hidden content leads to (`src/data/store/personalBuildReadModel.ts`, which filters the library's read model), and only the personal media files that the kept media refer to are copied into that build. The data is not part of the JavaScript bundle: the build writes it as `data/read-model.<hash>.json` next to `index.html` and the page loads it at start-up, so serve the whole build folder over HTTP (`npm run preview -- --mode personal`, or any static server); when the file cannot be loaded, the page names the file and the reason instead of staying blank. The development server keeps everything for the editor.

Every person who clones the open-source project receives the same local editing capability. No DeepSeek Harness, chat-command relay, or AI service is required for deterministic edits. An Agent remains useful when a country, city, date, coordinate, media type, or privacy decision is uncertain, but the editor never guesses those values.

The official maintenance workspace keeps editor data in `StarMap/06_private/data/editor-state.local.json`; a standalone clone may set `STARMAP_PRIVATE_ROOT` or use its ignored `06_private/` fallback. This state records display order, hidden items, photo covers, and media order. Country creation uses one Chinese / English / ISO-code autocomplete field backed by the bundled country catalog, then derives the canonical names, code, flag, and map center from the selected result. City creation appears only after entering a country; the user enters a name and explicitly presses Search. With a personal Cesium token whose public scopes include `geocode`, the loopback editor queries Cesium ion first. It falls back to a country-filtered OpenStreetMap Nominatim lookup when ion is unavailable, has no result, or times out. Both providers derive bilingual names and coordinates from the selected result; manual latitude/longitude entry remains available when online lookup cannot identify the city. Dates remain explicit user input. Hiding is non-destructive: source records and Inbox originals remain untouched.

The editor separates two similar-looking recovery actions:

- **Undo this round** returns the current unsaved ordering and hide/show draft to the state that existed when the editor was opened. It does not erase previously saved data.
- **Restore hidden items** explicitly removes saved hide flags, writes that change to the ignored local state, and reloads the page. It still does not delete or reconstruct source records.

Local-editor errors use the compatible flat response `{ ok: false, error, code, params?, details? }`. Known codes follow the interface language. An unreadable successful response is an unknown outcome. Durable photo/drone uploads discover actual server tasks rather than keeping browser storage as authority. An active runtime operation prevents competing in-page writes and reloads; pending or paused tasks release this runtime permit so ordinary editing remains available, while server media gates still protect uploads/imports/deletions. Opening, refreshing or navigating never retransmits bytes or repeats import. Explicit reselection accepts only never-started intended files; a confirmed whole-Inbox preview is required before import. Unknown reception/import stages remain for review. Writes are never automatically retried.

Online city lookup is explicit rather than autocomplete-on-every-keystroke. Each provider is limited to nine seconds, requests are cached in memory, and OpenStreetMap calls are serialized, country-filtered, visibly attributed, and follow the public [Nominatim usage policy](https://operations.osmfoundation.org/policies/nominatim/). Chinese Nominatim results accept exact names and equal-length simplified/traditional variants such as `波尔图` / `波爾圖`, while rejecting unrelated longer substring matches such as `赫本` inside another place name; retry with the local/English name or use manual coordinates when necessary. Cesium ion results may contain either a point or a bounding box; StarMap uses the box center when no point is supplied. Do not turn this path into bulk geocoding. The country catalog is supplied by the ODbL-licensed [`world-countries`](https://github.com/mledoze/countries) package and is used only by the loopback editor middleware, so it is not shipped in the public client bundle.

Media success payloads are also checked at runtime: upload responses must confirm a filename, positive byte count and Inbox-relative path; import responses must include string output and a list of restored media IDs. Empty output is valid; the ID list may be empty only when no source paths were requested. These checks remain for legacy API callers. Durable task responses additionally validate fixed library/target/file identity, revisions, completion summaries and preview selection; an unreadable response triggers read-only discovery, never an automatic retry.

## Media recovery server foundation (RD-07)

All editor writes and media CLI commands share a private-library filesystem lease. CLI preflight changes coordination records only. Discovery GETs and full-Inbox preview POSTs are entirely read-only. Photo/drone panels now create durable tasks, and the shared bilingual recovery center discovers them at startup and on browser focus. Reception validates size/hash/decode and publishes without replacement. Import revalidates the confirmed whole-Inbox plan, persists stages and atomically records sealed completion. Completed tasks show history; uncertain unsealed operations stop for review. See [the API and limits](../docs/local-media-recovery.md), including partial selection, close, backup exclusions and interrupted-lock behavior.

## Verification

```powershell
npm run lint
npm test
npm run build:public
npm run privacy:check
npm run release:check
```

`npm test` runs every unit and script test with plain `node --test`, no bundler involved: `src/**/*.test.ts` (World Graph Core, see [`src/worldgraph/README.md`](src/worldgraph/README.md), the data layer, the derivation and its frozen baseline locks) and `scripts/**/*.test.mjs` (the local editor plugin, the media pipeline, backups, the privacy and release checks, the SQLite store host). The whole run takes a few minutes, most of it in the store tests; `node --test "src/**/*.test.ts"` or `node --test <file>` runs a part. When a derivation lock fails, `src/data/canonical/baselineLock.fixture.ts` explains how to get a readable difference. `npm run build:public` also type-checks (`tsc -b`).
The runner uses at most two file workers to bound memory while synthetic image
and process-exit checks run. This is a test-resource limit, not an application
memory requirement.

The formal store host (`scripts/store-host.mjs`, SQLite through `node:sqlite`,
Node 24.15 or newer) backs the new library (root README; since 3C-4d the only way personal data is written): the
plugin reads it through `scripts/store-session.mjs` and the projection of
`scripts/store-projection.mjs`, and `store:migrate`, `store:backup`,
`store:restore` and `store:export-v2` are its tools. It runs the rollback journal in
TRUNCATE mode with `synchronous=EXTRA` and `auto_vacuum=INCREMENTAL`. Opening
checks the header, versions, schema and `store_meta` only; `quick_check` runs at
open only when the last writer did not close the store (its `clean_shutdown`
flag), and otherwise on request (`checkIntegrity()`). Ordinary writes take no
library lease: they are refused while another operation holds the library
operation lock, and SQLite keeps concurrent writers apart. `npm test` covers it,
including real writer processes killed at each write phase, and runs its
benchmark at a 1,000-entity smoke scale only. The full benchmark runs separately,
in segments that are each a separate command, at two scales: `real` (3,000
places, 10,000 entries and 10,000 media entities, where the targets apply) and
`stress` (the earlier 10,000 / 30,000 / 50,000 scale, recorded only):
`npm run store:bench -- --dir <absolute work directory> --scale real|stress --segment load|validate|copy|commit|cold|age|prune|modes`
(see the header of `scripts/store-bench.mjs`). The new library itself is
measured on the plugin path with synthetic V2 data migrated at the real scale (since 3C-4d its write segments measure
the store only): `npm run store:bench:mode -- --dir <absolute work directory> --segment generate|read|http|pipeline|editors|media|backup|restore`
(see the header of `scripts/store-mode-bench.mjs`; `npm test` runs a tiny scale). In the new library the eight
editor writes run V2's write functions on the read model and commit only the records that changed
(`src/data/store/diffV2.ts`); after a commit the files after the write are the next read model, without reading
the store again. `STARMAP_STORE_VERIFY=1` makes the dev server project the store after every commit and compare it
with that read model (development and tests). Every connection to a store file, tests and benchmarks included, is
opened through `scripts/store-sqlite.mjs` in the same TRUNCATE journal mode: on Windows a connection in SQLite's
default DELETE mode cannot commit while the dev server has the store open. The dev server's session prunes receipts
and `op_log` (`pruneLogs`) when it opens the store and after every 200 commits, one small step at a time after the
response; `build:personal` opens the store read-only (no writer session, no clean-shutdown mark, no write lock); a
store whose open check fails with `E_STORE_CORRUPT` but can still be read is served read-only
(`privateStoreReadOnly`, writes `E_STORE_READ_ONLY`). `store:backup` and `store:restore` include the media
(`MediaInbox/`, `media/user/`; since 3C-4c not the V2 media source index, and the store's media registry is checked
against the files) with the rules of `npm run backup`; the benchmark's `media`, `backup` and `restore` segments measure
them at the real scale. Media in the new library (3C-4c) goes through `scripts/media-service.mjs` (imports and
deletions, one commit each), `scripts/store-media-jobs.mjs` (media tasks) and `scripts/store-media-cli.mjs`
(`media:check` / `media:import`); `node scripts/store-media-bench.mjs --mode store` measures its operations on the
plugin path (see its header; `npm test` runs a tiny scale). 3C-4d: `scripts/private-data-source.mjs`
(`privateDataState`) decides per request whether a private root is a store, needs migrating (V2 or legacy data),
needs recovery (leftovers under `data/store/`) or is empty; only a store is written, an empty root gets its empty
library from the dev server (`scripts/store-init.mjs`), and everything else answers `E_STORE_MIGRATION_REQUIRED`,
`E_LEGACY_UNMIGRATED` or `E_STORE_RECOVERY_REQUIRED` before reading a request body.
The read model `starmap.read-model` (3C-5A) is a read-only copy of the store's rows (Core `src/worldgraph/readModel/`):
the host builds it with `readModel()`, without tombstones, review receipts or the host's own tables, and
`npm run store:export-read-model -- --out <new file> [--public]` writes it (`--public`: `src/data/store/publicReadModel.ts`;
the coordinate of the map's default camera is published, media assets lose their original file names).
The App does not read it yet (3C-5B).
`npm run library:recover` clears a library operation lock left by a crashed
writer after checking the data; see the root README.

### Browser regression and performance baseline

```powershell
npx playwright install chromium
npm run test:browser
npm run perf:browser
```

The browser runner creates a new temporary private root from neutral tracked test fixtures, blanks map-provider credentials, uses bundled local imagery, and blocks external browser requests. It starts the standard personal Vite profile on loopback port 5173 and refuses to reuse an occupied port. Tests exercise real local writes, synthetic image upload/import (including lost responses and failed reception), and Want to Go conversion; your own private root is never used. Each case launches and closes its own browser; the synthetic disk fixture is shared only within the serial run. Before the first case, the development-server groups warm Vite once (`tests/browser/dev-server-warmup.mjs`): a throwaway browser opens the map, then Collection, and reloads it, so the first case of a runner or shard does not pay the cold-server cost; the run fails if this read-only warm-up changed any synthetic file. The performance baseline and the public smoke skip it. Playwright closes its server and browsers at the end, and the runner removes only its own temporary data directory.

`test:browser` covers language switches with note/date drafts, country/city selection and the city Want to Go shortcut, explicit whole-Inbox import consent without reupload, Collection conversion, mobile panel drafts, and the forced-sample read-only boundary. Media-recovery checks add lost responses, cleared browser storage, fresh-context discovery, partial reception and explicit file reselection, cross-tab stale plans, historical hide/order/delete preservation, mobile translation, drone metadata and uncertain failed reception without automatic retry. Time-filter checks add equivalent year/custom ranges, invalid drafts, cross-year grouping, independent source identities, full management inputs, mobile operation, manual country evidence without coordinates, camera stability, layer toggles, storage failures and draft preservation. Browsing checks assert unchanged synthetic data; explicit conversion, restore and photo-save checks validate only their intended temporary fixture writes. The colliding planned-conversion failure case injects a non-writing error response to check request identity and retained drafts. Since 3C-4d the fixture (`scripts/browser-fixture.mjs`) is a new library: the runner migrates it before the dev server starts, `readFixture` reads the store's projection, and cases reset or patch it with one commit (`resetFixture`, `patchFixture`; media items stay as they are, so cases that need media import real Inbox files through the media service, `importInboxMedia`). The critical-flow group ends with four editor writes with the request protocol (a Collection note, a Want to Go item added on the map, a conversion with a trip choice, a saved city order) and a case that moves the fixture's store aside and a store damaged beforehand into place (`setStoreAside`, `enterDamagedStoreMode`): the page shows the data read-only with its notice and a note save is refused with `E_STORE_READ_ONLY`; Windows cannot move the store the dev server holds open, so that case skips itself there. The media-recovery group ends with four media cases on the same store (an unfinished task is abandoned first): a photo uploaded and imported from the recovery center shows in the city photos; the same photo uploaded again is a new record sharing the generated files; a photo hidden and deleted for good disappears with its Inbox and generated files; a file replaced in the Inbox is listed as a source match that must be confirmed before the import. The `--migration` group (`*.migration.mjs`) runs on a fixture left as V2 files: the page shows the migration notice, a save and the media task list are refused with `E_STORE_MIGRATION_REQUIRED`, `store:migrate -- --apply` runs while the page is open, the page switches to the new library by itself and a save works. CI runs the critical-flow (15), media-recovery (9) and migration (1) groups whole and the time-filter group (17) in three shards of 6, 6 and 5 cases. Every entry runs on its own runner with one worker and its own isolated data/service. The time-filter files use Playwright's parallel mode so that a shard can take single cases; each of their cases rebuilds the synthetic fixture before and after itself. The media-recovery file stays serial and whole because its cases share task history in one synthetic library. The required **Public checks** gate succeeds only when clean-source checks, every browser group and shard, and the public build smoke succeed; failed, cancelled or skipped entries do not pass the gate. Failed synthetic evidence artifacts include the group name and shard and retain their seven-day limit. Reports are ignored under `playwright-report/browser/`; screenshots and traces for failures are under `test-results/browser/`.

For a focused recheck, use `npm run test:browser -- --time-filters`, `--critical-flows`, `--media-recovery` or `--media-lifecycle`. The last option selects only the recovery lifecycle case. All retain the isolated synthetic-data and port safeguards; the full default local command runs the critical-flow, media-recovery and time-filter suites. Add `--shard=<current>/<total>`, for example `--time-filters --shard=2/3`, to rerun one CI shard: the runner passes it to Playwright unchanged and refuses every other option. Playwright itself reports a shard that received no case as a pass, so the runner first lists the shard's cases (`--list`, same selection) and exits with an error when there are none.

`npm run test:browser -- --public-smoke` checks the public build instead of the development server. Run `npm run build:public` first: the runner serves the existing `dist/` through `vite preview` on port 5173, with an empty temporary root and no synthetic data, and runs only `tests/browser/*.smoke.mjs`. The cases check that the page shows the neutral sample without write controls or any `/__travelatlas/editor/*` request, and that the preview returns no editor data for `/__travelatlas/editor/state`. A third case checks how the build loads Cesium: its code comes from one content-hashed `assets/cesium-<hash>.js`, and its workers and assets load successfully from `cesium/<version>/`. The default run never includes them. In CI, the **Public build smoke** job also refuses the bundle when a server-only marker (`STARMAP_PRIVATE_ROOT`, `06_private` or `operations/media-import`), the local editor's request prefix `/__travelatlas/editor`, or the host of the third-party flag service the app used before batch 7 appears in `dist/**/*.js`. No build contains the editor client: `src/data/localEditorClient.ts` loads the editor API, and `App.tsx` the editor-only dialogs, only through dynamic imports under `import.meta.env.DEV && localEditorAvailable`, which builds reduce to `false` before chunks are formed (the comment in `src/data/editorState.ts` explains why the `import.meta.env.DEV` half is needed). The Collection page, the updates page and the city photo viewer are loaded when first opened, and `exifr` only when the local editor reads a drone file.

The camera time-filter regression waits for the selected city's actual Cesium flight-completion callback and then checks stable pose samples within one 15-second budget. Pose tolerances remain 0.1 metres for height and 0.000001 degrees for each angle/coordinate. It preserves the original baseline when excluding the city or clearing filters. The DEV-only read-only command snapshot observes completion/cancellation for city, country, place and overview flights; other command types remain `issued` rather than implying completion. No viewer is exposed by this snapshot and public builds do not install it. The test writes `camera-browse-evidence` to its attachment and stdout on success or failure, including command identity/status, pose samples and raw deltas; this is diagnostic evidence, not proof of every low-level Cesium call or a past CI failure's cause.

### Browsing by time

Open **Time filters** on Map or Journey, or a layer's time entry in the Layers menu. Each layer has independent year shortcuts, inclusive start/end dates (either may be open), uncertain-date inclusion and clearing. Travel uses original visit intervals; saved places use their added date, while travel plans use their planned visit interval, including its end date. Valid conditions are remembered locally; invalid drafts remain editable and are never saved.

Map and Journey share date evidence. Cross-year visits can appear in multiple applicable year cards, while overall counts deduplicate record identities. Date uncertainty is reported separately. Active travel filtering uses original adjacent record endpoints, so removing a middle visit never creates a shortcut route. Clearing uses the original all-time map path. Closing a layer retains its condition; changing conditions does not move the camera.

Collection keeps all records, including hidden or coordinate-less entries. Sorting, duplicate checks, conversions and saves use complete inputs. An already open detail or editing draft remains available when its source falls outside the time range, with an explicit notice and a clear-filter action. Local query preferences store no records or notes, and do not change the V2 files. The raw date/adjacency context is an auxiliary export in `src/data/appData.ts`; the six legacy module exports and baseline format @4 are unchanged and covered separately.

`perf:browser` adds 1,000 synthetic Want to Go places and records map UI readiness, Collection opening, scroll animation-frame intervals, long tasks, and layer toggle timing. Its JSON attachment and report are under `test-results/performance/` and `playwright-report/performance/`. Measurements use a headless browser, software WebGL, and a development server; UI readiness and two animation frames do not prove globe imagery has finished rendering. They are a descriptive local baseline, not CI performance thresholds or production-device acceptance. Performance collection is an explicit separate command and is not part of the required CI job.

The server lifecycle uses [Playwright's webServer configuration](https://playwright.dev/docs/test-webserver), with `reuseExistingServer: false` to prevent writes to another preview's data.

## Public Sample and Private Data

StarMap has two data layers:

- `src/data/sample/` is the tracked neutral North Atlantic demonstration used by a clean open-source clone: a five-city journey plus a Want to Go sample with three places (Nuuk, Tromsø, Akureyri). Akureyri is one place in both layers, so the public map shows the heart badge. Since 3C-5B the app reads its read model `sample.read-model.json` (see [Edit the native sample](#edit-the-native-sample)). The same sample as five hand-maintained V2 files stays in `src/data/v2-sample/`, as an input of the migration and compatibility tests (see [Edit the V2 sample](#edit-the-v2-sample)).
- `<private-root>/data/` is the external private layer containing the owner's countries, cities, routes, coordinates, display rules, Want to Go list, editor state, and media catalog. Its layout is described in [Private Data Format](#private-data-format).

The private layer is considered only in the explicit personal profile. Public preview and public build ignore it even when it exists; they, and forced sample mode (`VITE_TRAVEL_ATLAS_DATA_MODE=sample`, or `?data=sample` in development), read the native sample `src/data/sample/sample.read-model.json`. Forced sample mode previews the public site: the local editor is off even in the personal profile, so the page renders exactly as in public mode, with no editing control, and nothing can be written to the private folder from it.

In the personal profile, Want to Go never falls back to the sample: sample items are not in the private file, so the editor could not hide them. When the private Want to Go file does not exist yet, the list is empty. The add entry and the Hide button are rendered only for private data, in addition to the existing development-only editor gate.

Adding a city by name never reuses a registered place just because the name matches. `POST /__travelatlas/editor/records` and `POST /__travelatlas/editor/wanttogo` look for cities of the same country with the same Chinese or English name; when there is any, they answer `409 E_PLACE_CHOICE_REQUIRED` with the candidates (place id, names, location, distance, and whether it is a strong candidate: the same names, precise coordinates within 50 km) and write nothing. The city form and the Want to Go dialog list the candidates inline, preselect the first strong one (nothing otherwise) and resubmit with the chosen `placeId` or with `createNew: true`. A travel record that references a city by `placeId` uses that place's coordinates, and `E_CITY_EXISTS` still refuses a city that already has a record.

A trip title alone never joins an existing journey. A new visited record from `POST /__travelatlas/editor/records` or `POST /__travelatlas/editor/wanttogo/convert` (Want to Go items, and planned records that have no `journeyId` yet) looks for journeys whose visited records use exactly the same `trip_title`, including the default "country · city" title. Without an explicit choice, a title with no such journey starts a new journey as before; otherwise the endpoint answers `409 E_JOURNEY_CHOICE_REQUIRED` with `tripTitle` and the candidates (journey id, title, date range, up to five cities with their names, and the city count) and writes nothing. The client resubmits with `journeyId` (one of the candidates, otherwise `E_UNKNOWN_JOURNEY`) or `newJourney: true`. When a place choice is also needed, the place choice comes first, so one response carries only one kind of choice. Existing `journeyId`s are never rewritten, and dates never decide whether two visits are one trip. The mark-as-visited dialog and the city form list the trips inline with nothing preselected.

City details also offer **Mark as Want to Go** for the current city. This shortcut posts its existing `placeId` through the same loopback editor and write coordinator; it never resolves the selected city again by its display name or changes its travel records. Existing entries, including hidden entries, disable the add button. Hidden entries can be restored in Collection. Public and forced-sample views render no shortcut. An ambiguous or unknown write outcome locks retry until the user reloads and verifies the list.

## Whole-library backup and recovery

An offline directory-snapshot tool preserves a root's V2 files, source index, Inbox originals/sidecars and local media (take it before `npm run store:migrate -- --apply`; on a root with a new library it uses `store:backup`). `npm run backup -- create --root <explicit-private-root> --out <fresh-backup-directory>` creates a checked snapshot; `inspect --from <backup-directory>` validates it. `restore --from <backup-directory> --to <fresh-private-root>` previews recovery, and `--apply` creates that new directory. Existing directories are always refused and activation is manual, leaving the previous root available for rollback. Use separate private storage and stop personal previews/importers before creation. Configuration and credentials are excluded. See [scope, commands, validation and limitations](../docs/local-backup.md).

## Private Data Format

The personal profile, the local editor, and the scripts write personal data only to the new library, `<private-root>/data/store/world.sqlite` (root README). Every country and city is a place with a permanent id; travel records, Want to Go items, editor state, and media refer to places by id. The App reads the library as the five V2 files it projects: `places`, `travel-map`, `want-to-go`, `editor-state`, and `user-media`.

Earlier versions wrote these as files in `<private-root>/data/v2/` (`places.local.json`, `travel-map.local.json`, `want-to-go.local.json`, `editor-state.local.json`, `user-media.local.json`, plus the media importer's `media-source-index.local.json`). A private folder that holds them and no new library is shown read-only until `npm run store:migrate -- --apply` migrates it (back it up first with `npm run backup -- create`); the migration leaves them as they are. `npm run store:export-v2` writes the new library as such files again.

A new private folder gets an empty new library when the personal preview first starts, and an empty map with the hint “还没有足迹，从添加第一个城市开始。”; nothing is copied from the sample. Do not edit the new library or the V2 files by hand; use the local editor or the media importer. `.bak` files, which every V2 file write kept as the previous version, never count as data files.

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
6. **Migrate to the new library** (3C-4d): the folder now holds V2 files and is read-only; back it up (`npm run backup -- create`), then run `npm run store:migrate` and `npm run store:migrate -- --apply` (root README, "The new library").

A private folder without legacy data needs no legacy migration. There is no switching back to the legacy format.

After the migration the four legacy files are leftovers that StarMap does not read; keep or delete them. The same holds for `data/data-mode.local.json`, the data-mode marker written by earlier versions: it is ignored.

Media keep their catalog entries through the migration. The first media import after the migration gives every item a new id based on its file content, so ordering, hiding, and covers saved for the old ids no longer apply; the dry run reports how many items are affected.

### Edit the V2 sample

The five V2 files in `src/data/v2-sample/` were what the public build read until 3C-5B; they are now an input of the migration and compatibility tests, must stay equal to the native sample, and are maintained by hand; no tool generates them. After editing them, run `npm run privacy:check`: it checks that the directory holds only these five files, that they pass the V2 validation, and that the sample stays neutral (`privacy_level` is `public-sample`, Want to Go ids start with `wtg_`, no hidden or editor-written items). New places need new UUIDv7 ids. `npm test` also pins the sample's derived baseline (`node scripts/baseline.mjs --sample`), so a deliberate change to the sample updates that lock in `src/data/canonical/baselineLocks.fixture.ts` too.

### Edit the native sample

`src/data/sample/sampleSource.ts` is the public sample in the new library's own format: its places, footprint records, Want to Go items and journey, one line each, laid out as the store's rows with fixed ids, time and order (the file's header says how the first version was made from the V2 sample). `npm run sample:build` plans those rows with Core's planner on an empty store and writes the read model `src/data/sample/sample.read-model.json`; commit the source and the generated file together, and never edit the generated file by hand. `npm run privacy:check` applies the V2 sample's rules to it (public-sample marks, runnable and neutral entries, nothing hidden or editor-written, no local path) and requires the committed file to be exactly what the source generates (`npm run sample:build -- --check` checks only that). `npm test` also requires that the sample, through the official view, derives the locked public baseline and gives back the five V2 sample files when exported as V2. The public build reads the native sample since 3C-5B; a change to the sample is still made in both (the V2 sample feeds the migration tests), and the two must stay equal.

Run `npm run privacy:check` before every public release. See the [open-source privacy boundary](../03_Reference/TravelAtlas_open_source_privacy_boundary.md) for the boundary table and deployment options.

## Import Personal Media

Users can simply ask an Agent to read the StarMap rules and explain how to import their photos. The Agent starts with the short [Media Inbox README](../02_Assets/MediaInbox/README.md), checks that every item has a reliable existing country and city, and asks before proceeding whenever required information is missing or uncertain.

After real files follow the tracked template inside `<private-root>/MediaInbox/`, run:

```powershell
npm run media:check
npm run media:import
```

The first command is read-only and reports unresolved countries, cities, formats, or drone metadata. After a clean preflight, the second command preserves a local original copy and generates two WebP derivatives for every still image: a `640 px` thumbnail for city/sidebar/card surfaces and a `2400 px` preview for the photo viewer. Full-resolution photos and panoramas are requested only by explicit viewing actions. All three tiers use stable, hash-based paths inside the ignored local user library, and the ignored catalog records their dimensions. Generated files are written to same-directory temporary files and published without overwriting, so an interrupted import never leaves a truncated output; the next import removes leftover temporary files. `npm run media:check -- --verify` re-hashes existing originals against their content-addressed directory, and the files named by completed media-task receipts, and only reports mismatches. Restart the preview after importing.

Inbox source media must never be moved, renamed, overwritten, or deleted. Agents may create or update only the private control files `place.json`, `country.json`, and city-level `media.json`; `place.json` is normally written by StarMap itself. Supported still formats are optimized outside the Inbox by the importer, while unsupported formats still require a separate user-approved conversion step.

The importer resolves each country and city folder against the place registry (`place.json`, then a legacy `country.json`, then the folder name) and derives every media id and generated path from the file content alone. A folder matched only by name (or by a legacy `country.json`) is a folder binding to confirm, even with a single match: `npm run media:check` lists it, `npm run media:import` refuses to write (exit code 2) until it is run as `npm run media:import -- --accept-folder-bindings`, and only then is `place.json` written into the folder. Media tasks show the same bindings in their import preview with a separate confirmation. Uploads, including media-task reception, never claim a hand-made folder: they use only a folder whose `place.json` already names the place, or a folder they create and pin (`<name> (<place id suffix>)`, then `… 2` to `… 9`), so a same-name folder without `place.json` is left untouched for that confirmation. The [Media Inbox README](../02_Assets/MediaInbox/README.md) describes the rules.

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
- `vite.config.ts` loads Cesium as [Cesium's own Vite example](https://github.com/CesiumGS/cesium-vite-example) does: a build bundles the `cesium` sources into `assets/cesium-<hash>.js` and copies Cesium's run-time files (`Workers`, `ThirdParty`, `Assets`, `Widgets`) unchanged to `cesium/<version>/`, which `CESIUM_BASE_URL` names. The project's own plugin `scripts/cesium-static-plugin.mjs` (Node built-ins only) does the copy, and on the dev server serves those files from `node_modules/cesium/Build/Cesium/` at the same URLs, answering 404 for any path outside the four directories. The dev server also loads Cesium's minified build instead of bundling the sources, which keeps a development page load at about 33 MB instead of 55 MB. Caching advice for hosts: [Caching the public build](../README.md#caching-the-public-build).
- `src/components/CollectionPage.tsx` is the Collection view: every Want to Go entry, including hidden and coordinate-less ones, with search, filters, sorting, note editing, hide / restore / delete, and View on map.
- `src/worldgraph/collection.ts` is the Core list query behind it (`queryCollection` / `filterCollection`); unlike the map query it ignores layer visibility and keeps hidden entries.
- `src/extensions/` holds the Google imagery, labels, and Photorealistic 3D Tiles integrations; see [`src/extensions/README.md`](src/extensions/README.md).
- `src/data/rawInputs.ts` chooses the read model the app reads: the native sample in public and forced sample mode, otherwise the private read model (the library's, or the `data/v2/` files of a root that is not a library yet, migrated in memory). The read model is never part of a module: the profile-specific virtual module only names its address, which the page fetches at start-up: the dev server's read-only endpoint `GET /__travelatlas/editor/read-model?revision=N` (behind the cross-site guard and the read checks of the other editor reads; the revision changes the address after every save), or the data file of a personal build. `src/data/appData.ts` sees it through the official view (`officialViewOf` in `src/data/store/projectCanonical.ts`) and derives the data modules from it.
- `src/data/travelAtlas.ts` exports the travel data derived from those inputs.
- `scripts/legacy-data.mjs` decides whether a private folder still holds legacy-format data that has not been migrated (the migration itself runs on commit `4fd32a9`, see [Migrate legacy-format data](#migrate-legacy-format-data)).
- `scripts/baseline.mjs` (`npm run baseline`) writes the derived baseline of the public sample (`--sample`, the native sample's read model) or of the private data (the library's read model, never the possibly stale `data/v2/`; a root that is not a library yet is migrated in memory as the dev server does) as byte-comparable JSON, through the app's own pipeline, and compares two baselines (`--compare`).
- `src/data/wantToGo.ts` chooses the Want to Go source (tracked sample, private file, or none) and parses it through the Core adapter.
- `src/data/worldGraph.ts` merges the travel, want-to-go, and planned-record snapshots into the single World Graph snapshot that the map queries.
- `src/data/mediaCatalog.ts` receives personal media only in personal mode; `src/data/droneMedia.ts` contains no built-in user media.
- `scripts/private-profile.mjs` resolves the external private root without reading or printing secrets.
- `scripts/local-editor-plugin.mjs` provides the loopback-only editor in personal development and injects no private data in public mode; `scripts/private-data-module.mjs` holds its virtual-module and file-watch rules. `scripts/local-editor-request-guard.mjs` holds its request checks: in the personal profile Vite's CORS is off, a guard ahead of Vite's own middlewares refuses cross-site and same-site browser requests other than page navigations (so another local page cannot read the private-data module, `/media/user/*`, `/@fs/` or the editor), and the read-only endpoints and `/media/user/*` accept only same-origin reads. `vite preview` (`npm run preview`) may serve a personal build, so in every mode it grants no CORS and runs the same cross-site guard ahead of its own middlewares. See `03_Reference/TravelAtlas_open_source_privacy_boundary.md`.
- `scripts/v2-editor-store.mjs` and `scripts/v2-media-store.mjs` read and write `data/v2/` behind the editor's write endpoints; the rules themselves, including Mark as visited, are pure functions in `src/data/v2write/` and `src/data/v2media/`.
- `src/data/store/` is the App side of the formal World Graph store (`src/worldgraph/store/`); nothing reads or writes it yet. `officialDefinitions.ts` holds the official `starmap:*` entity types, layers, relation type and sources, the `v2:*` import sources, and one view scope per V2 semantic. `migrateV2.ts` turns the five V2 files into one dependency-ordered command batch that `planCommands` writes into an empty store; it refuses, generating nothing, when any record would be lost, and keeps every value without a formal field verbatim in the row's `extensions.v2`. `projectCanonical.ts` projects the store back to `CanonicalData`, so the existing derivation and `serializeV2` (export as V2) work unchanged; rows that Canonical cannot express, such as entries of another layer, are listed as skipped.
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
