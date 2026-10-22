<p align="center"><b>English</b> · <a href="README.zh.md">简体中文</a></p>

# StarMap

An open-source, local-first personal world graph and 3D world atlas. StarMap turns places, journeys, photographs, aerial media, and the things you care about into an interactive map of your own world.

StarMap is built with React, TypeScript, Vite, and Cesium. A clean clone opens with neutral sample data. Your own journeys, media, editor state, and environment values stay in Git-ignored local files by default.

This repository is the **StarMap Core / Community Edition**, licensed under [MIT](LICENSE). It is a complete product on its own and keeps receiving real features. StarMap began as a fork of [Aisland-SJL/StarMap](https://github.com/Aisland-SJL/StarMap) and is now developed independently; the upstream project is credited in [NOTICE.md](NOTICE.md). Related editions and their licenses are listed in [docs/editions.md](docs/editions.md).

## Product preview

<table>
  <tr>
    <td width="68%"><img src="docs/images/01-globe-overview.webp" alt="StarMap globe overview"></td>
    <td width="32%"><strong>Explore the whole globe</strong><br><br>Start from a complete world view and travel to any corner of the Earth. Visited countries, cities, and journey routes remain visible on the globe.</td>
  </tr>
  <tr>
    <td width="68%"><img src="docs/images/02-meteor-galaxy-closeup.webp" alt="Milky Way and close globe view"></td>
    <td width="32%"><strong>From the Milky Way to ground tiles</strong><br><br>Move closer to see the night sky and Milky Way, then continue zooming toward detailed terrain and imagery tiles on the surface.</td>
  </tr>
  <tr>
    <td width="68%"><img src="docs/images/03-city-location-and-altitude.webp" alt="City panel with precise photo and drone positions"></td>
    <td width="32%"><strong>City-level media positions</strong><br><br>Open a city panel to locate photographs and drone media by their precise coordinates and altitude, while browsing the city's photos and media entries.</td>
  </tr>
  <tr>
    <td width="68%"><img src="docs/images/04-drone-panorama-viewer.webp" alt="Drone 360 panorama Viewer"></td>
    <td width="32%"><strong>Drone 360° panorama Viewer</strong><br><br>Open aerial panoramas inside the built-in Viewer for an immersive, zoomable view without leaving the atlas.</td>
  </tr>
</table>


## Highlights

- Interactive Cesium globe with country, city, route, and camera navigation.
- Map and Journey views with responsive glass UI.
- Map layer panel: switch the Travel and Want to Go layers on or off independently; the choice is remembered across sessions.
- Places you want to go: add a city or a whole country with a note, hide, restore, or permanently delete it, and see a heart badge where it overlaps a city you have already visited.
- Local editor for countries, cities, ordering, visibility, city photos, and drone media.
- EXIF-first drone import: selected files are inspected immediately for date, GPS coordinates, absolute altitude, relative altitude, and camera information.
- Missing metadata is requested only when needed. The date is required; coordinates and altitude remain optional.
- Aspect-ratio-safe photo gallery for both landscape and portrait images.
- Three-tier private media pipeline: lightweight thumbnails, viewer previews, and preserved originals.
- An in-app GitHub Release update guide.
- Repeatable critical browser regression with isolated synthetic data, plus a separate 1,000-place performance baseline command (see `01_Web/README.md`).
- Independent layer time filters with year or date ranges, cross-year Journey grouping, and separate uncertain-date evidence. Collection and editing keep complete source data.
- Privacy audit and public/private data separation designed for open-source reuse.

## Quick start

Requirements: Git and Node.js 24 or later (`01_Web/.nvmrc`; `package.json` declares it in `engines`).

```powershell
git clone https://github.com/b532459418-lab/StarMap.git
cd StarMap/01_Web
npm ci
npm run dev:public
```

Open `http://127.0.0.1:5173/`. This public profile uses only neutral sample data and needs no credential.

For a personal atlas, create an external private layer next to the source repository (the official maintenance workspace uses `StarMap/06_private/`), copy `.env.example` to its `config/.env.local`, and run `npm run dev:personal`. In a standalone clone, set `STARMAP_PRIVATE_ROOT` to any private folder or use the ignored `StarMap/06_private/` fallback. Personal configuration, journeys, media, and editor state remain physically outside the source repository.

## Interface language

Choose 中文 or English next to the top navigation. On your first visit StarMap uses the first supported browser language, falling back to English. A manual choice is saved in this browser and takes priority on later visits. Navigation, map place labels, mouse controls, and Collection wording, country names, search, and name sorting follow that choice. Search also matches names in other languages. Place names fall back to available registry names when a translation is missing. Country and city details, Journey timeline and year cards, country/city editing, location search, and the Want to Go add/convert dialogs also follow this setting. Photo and panorama viewers, drone-media forms, map-source and layer menus, private-data empty and migration notices, release-center controls, and known local-editor errors now follow the same setting. Changing language keeps form drafts and user-written notes and titles intact without automatically rewriting them; a known original place name appears only when the registry supplies its original language. Publisher-written release announcements, external diagnostics, and unrecognized errors retain their original text. Map-provider imagery labels are separate from this setting.

## Map credentials — start here

StarMap can start without a token by using its bundled low-resolution Natural Earth II fallback. For Cesium ion online global imagery:

1. Sign in or create an account at [Cesium ion](https://ion.cesium.com/).
2. Open [Access Tokens](https://ion.cesium.com/tokens) and create an app-specific public token.
3. For the easiest local start, keep the normal public scopes, including `geocode` if you want city-name search; keep every private scope disabled. For a production site, restrict Allowed URLs and accessible assets to what the deployment actually needs.
4. Open your private layer's `config/.env.local` and enter the value after `VITE_CESIUM_ION_TOKEN=`.
5. Restart the development server.

Never commit a token or paste it into an AI chat, issue, screenshot, log, or README. A browser-side production token is observable by visitors, so use a separate production token with URL and asset restrictions.

If you want AI assistance, give your Agent this prompt:

> Read `AGENTS.md`, `README.md`, `01_Web/AGENTS.md`, `01_Web/README.md`, and `01_Web/.env.example`. Explain the three StarMap imagery sources and ask whether I need Cesium ion, Tianditu, or only the bundled local fallback. Guide me through obtaining any credentials I choose and configuring `VITE_MAP_SOURCE`, `VITE_CESIUM_ION_TOKEN`, and `VITE_TIANDITU_TOKEN`. Never ask me to paste or reveal a complete token or key; tell me exactly where I should enter it in the external private layer's `config/.env.local`, verify only non-secret presence and live map behavior, then start `npm run dev:personal` and explain the basic controls. Never copy private data into the source repository.

## Switch between Cesium and Tianditu

Cesium remains StarMap's 3D globe engine. The source switch changes only the imagery drawn on that globe. Users who need a mainland-China-accessible source can apply for their own key at [Tianditu Developer Resources](https://lbs.tianditu.gov.cn/) and keep both credentials in the private layer's `config/.env.local`:

```text
VITE_MAP_SOURCE=tianditu
VITE_CESIUM_ION_TOKEN=
VITE_TIANDITU_TOKEN=
```

`VITE_MAP_SOURCE` accepts `auto`, `cesium`, `tianditu`, or `local`. The Layers button always lists Cesium, Tianditu, and the bundled local fallback. A steady green light means the required value is present (or the local source is built in); a red light means the online source is not configured and cannot be selected. This check never displays or validates the credential itself. The browser remembers the selected available source. Changing `.env.local` still requires restarting the development server. Both online values are public-client credentials in a built static site, so use app-specific keys and apply the provider's production restrictions.

## Add your journeys and media

Development mode includes local editing controls. Use them to add or reorder countries and cities, hide or restore items, choose photo covers, and import city or drone media. Production builds do not include these write controls.

Known editing and location-search failures follow the interface language. An unreadable ordinary edit requires a reload and verification before retrying. Photo and drone uploads create a durable local task before receiving bytes. Open Media tasks after a refresh or a new browser session to read the server facts. Review the whole Inbox, including other cities, and explicitly confirm its scope before importing. Unsent files require explicit reselection and confirmation; uncertain writes are never replayed. Pause keeps originals and allows ordinary editing, while another media batch and media deletion wait. A verified completed task displays history and can be closed without deleting its files. A task that cannot finish can be abandoned after a confirmation: received files stay in the Inbox, generated outputs are not rolled back, and you can upload or import again.

City creation uses Cesium ion geocoding first when the personal token is configured with the `geocode` public scope. If ion is unavailable, has no result, or exceeds nine seconds, StarMap falls back to an explicitly triggered, country-filtered OpenStreetMap lookup. The interface never spins indefinitely: users can retry with the local/English city name or switch to manual latitude and longitude entry.

A name alone never decides which place a new city is. When you add a city, or a Want to Go city, and the country already has a place with the same Chinese or English name, nothing is saved yet: the form lists those places with their names and approximate distance, plus **Create a separate place**. A place with the same names within 50 km is selected for you; otherwise you choose. Confirm with the same button.

A trip title never decides on its own which trip a visit belongs to. When you mark a Want to Go place or a planned trip as visited, or add a city, and its trip title (the one you typed, or the default "Country · City") is already used by an existing trip, nothing is saved yet: the dialog lists those trips with their dates and cities, plus **Create a new trip**. Nothing is selected for you; choose one and confirm with the same button. StarMap never groups visits into one trip by their dates.

When drone files are selected, StarMap immediately reads available EXIF/XMP metadata and displays it per file. Values found in the file are locked as file-derived facts. Only missing values become editable; a missing date must be supplied, while coordinates and altitude can be left blank.

For bulk media, follow the tracked `02_Assets/MediaInbox/` template but place real source files under the external private layer's `MediaInbox/`, then run:

```powershell
npm run media:check
npm run media:import
```

A folder you put into the Inbox yourself is matched to a place by its name only as a hint. The first such binding needs your confirmation, even when only one place matches: `npm run media:check` lists each `folder → place`, and `npm run media:import` writes nothing (exit code 2) until you run `npm run media:import -- --accept-folder-bindings`. Media tasks show these bindings in their import preview with their own checkbox. Folders that already have `place.json` are not affected. Uploads from the editor never take such a folder over: when a folder with the same name has no `place.json`, the upload creates a new folder, for example `Suzhou (1a2b3c4d)`, and leaves yours untouched.

The importer never rewrites Inbox originals. It publishes generated files only after they are completely written, and `npm run media:check -- --verify` re-checks existing originals, and the files named by completed media-task receipts, against their content hashes. Personal source media, generated derivatives, local travel records, editor state, and `.env.local` stay in the external private layer and never enter the source repository.

Media recovery is connected to the photo and drone panels and discovers durable tasks on startup. Task reads and import previews write no library files. Completed operations retain historical results without restoring later hide/order/delete decisions. A completion receipt covers only its own task, so it does not grow with the library, and reading tasks compares file sizes and modification times instead of hashing the library. CLI preflight changes only coordination records; backup excludes tasks, locks and staging. See [recovery contracts and limits](docs/local-media-recovery.md).

The library's coordination records are bound to the private root's path. If you move or rename the private root, or its drive letter changes, every write stops with `E_LIBRARY_ROOT_MOVED` instead of reporting a busy library. Stop the personal preview, then run `npm run library:rebind` in `01_Web/`: it prints the old and new bindings and changes nothing. If this is the same library, run `npm run library:rebind -- --confirm` to rebind it to the current path. The command refuses while an operation lock exists.

If StarMap or a media command crashes or is killed while it holds the library operation lock, the lock stays behind and later writes report a busy library. A lock is never released because it is old or because its process ID is gone. Once you are sure the program that held it is no longer running, run `npm run library:recover` in `01_Web/`: it prints the lock's holder, its creation time and the private-root binding, and changes nothing. Then run `npm run library:recover -- --confirm`: it first checks the library data (`quick_check` and a full validation of the new library; on a root not migrated yet, the V2 files and their place references) and removes the lock only when the check passes. If the check fails, the lock stays and the problems are listed; restore from a backup before writing again. With a new library it then also lists, with or without a lock, what media left behind: a backup's mark left by a backup that did not finish (deleted media files wait while it exists), media files waiting to be deleted, and generated folders no record names (left by an interrupted import; listed only, never deleted). With `--confirm`, after you made sure no backup is running, it removes those marks and deletes the waiting files. On a root without a new library it lists files left under `data/store/` instead and, with `--confirm`, moves them into `data/store-residue/<time>/`.

If the private root was also moved while the lock was left behind, `--confirm` alone refuses (the lock is bound to the old path) and `npm run library:rebind` refuses because of the lock. Run `npm run library:recover -- --confirm --rebind` instead: after the same data check it rebinds the library's coordination records to the current path, as `library:rebind` does, and then removes the lock.

## Places you want to go

The Want to Go layer marks places you have not been to yet. The map layers button in the bottom dock (地图图层, a separate button from the imagery-source menu) opens the layer panel, where the Travel and Want to Go layers can be shown or hidden independently. The browser remembers the choice across sessions.

In the personal profile (`npm run dev:personal`):

- **Add**: the layer panel ends with **+ Add a place you want to go** (添加想去的地方). Choose a country first, then search for a city online (the same Cesium ion / OpenStreetMap lookup used for city creation) or enter its name and coordinates manually; you can also add the whole country. An optional note records why you want to go. Adding the same place twice is refused with a notice that it is already on the list.
- **From city details**: choose **Mark as Want to Go** to save the selected city directly, including a city you want to visit again. It uses the existing place ID and keeps its names, coordinates and travel records. A saved city shows **Already on your Want to Go list**; hidden entries count too and can be restored in Collection. Finish any current city-photo edit first. Active media operations block this action, and an unknown write result requires a reload and verification before retrying.
- **Hide**: click a want-to-go marker to open its detail card, then choose **Hide** (隐藏). Hiding removes the marker from the map but keeps the entry.
- **Restore or delete**: hidden places are listed under **Hidden N items** (已隐藏 N 项) below the Want to Go toggle in the layer panel. Each one can be restored (恢复) or permanently deleted (彻底删除). Only hidden places can be deleted, and deletion cannot be undone.

When a place you want to go is also a city you have visited, the city keeps its travel marker and gains a heart badge. Hide the Travel layer and the same place appears as a hollow want-to-go marker.

The **Collection** tab in the top navigation lists every entry on the Want to Go layer, one card per entry, including hidden entries, places without coordinates, and places that are also visited cities (the map draws each place once, with a heart badge when it is in both layers). Search by name, country code, or note, filter by shown or hidden, and sort by date added, name, or country. **View on map** (在地图上查看) switches to the map, flies the camera to the place, and opens its detail card, turning the Want to Go layer back on if it was off. In the personal profile each card can also edit its note, hide, restore, or permanently delete the place; planned travel records and the public sample are read-only there, apart from **Mark as visited** for planned records.

Once you have been to a place, **Mark as visited** (标记为去过) turns it into a travel record in the personal profile. The button sits next to **View on map** on Collection cards and next to **Hide** on the map detail card. Enter the visit date yourself (the end date and trip title are optional); the city joins your travel records under the country you already use for that country code, and the want-to-go entry is removed unless you tick **Keep on the Want to Go list** (保留在想去列表（还想再去）), in which case the visited city shows the heart badge. Planned travel records can be marked as visited the same way: the record itself becomes a visited one with the dates you enter, and no new record is added. A whole country or a place without coordinates must first be narrowed down to a city with coordinates; its button is disabled and the reason is shown. A city that is already in your travel records has the button disabled with that reason (the editor also refuses such a request without writing anything); hide or delete the want-to-go entry instead. The want-to-go note is not copied into the travel record. After a successful conversion the page reloads on the new city, and the Travel layer is switched back on if it was off.

Your places are saved in the new library `<private-root>/data/store/world.sqlite` (see [The new library](#the-new-library)), outside the source repository like the rest of your private data. A new library starts with an empty Want to Go layer rather than the sample. Travel records with `status: planned` in your travel data also appear on the Want to Go layer; apart from **Mark as visited** they are read-only there, so change anything else in the travel data itself.

Public builds and `dev:public` show a neutral three-place sample instead (Nuuk, Tromsø, and Akureyri, which overlaps the sample journey to demonstrate the heart badge) and contain no add, hide, delete, or Mark as visited controls. Forced sample mode (`VITE_TRAVEL_ATLAS_DATA_MODE=sample`, or `?data=sample` in development) previews the public site: it shows the same sample, and the local editor is off even in the personal profile, so no editing control is rendered.

## Existing data in the legacy format

The personal profile reads the new library (below), or, until you migrate them, the V2 files in `<private-root>/data/v2/` of earlier versions; a new private folder starts with an empty map. A private folder created before the V2 format holds its data in the legacy format, which StarMap no longer reads. Until you migrate it, the map shows a migration notice, the local editor refuses to save, and the media import refuses to run, so nothing is written next to the unmigrated data. StarMap never migrates, moves, or rewrites your files by itself.

The current version no longer contains the migration tool; commit `4fd32a9` is the last version that has it. Migrate there, then return to the latest version:

```powershell
git checkout 4fd32a9
cd 01_Web
npm ci
npm run identity:check                  # dry run: read the report, nothing is migrated
npm run identity:check -- --apply       # write the V2 files
git checkout main
npm ci                                  # back on the latest version, then refresh the page
```

Resolve everything the dry run asks you to decide before applying. After the migration the legacy files, and the `data/data-mode.local.json` marker of earlier versions, are leftovers that StarMap ignores; keep or delete them. If you do not need the old data at all, move the four legacy files out of `data/` instead. The full steps, the decisions file, and what the migration means for media are in [01_Web/README.md](01_Web/README.md#migrate-legacy-format-data) (Private Data Format). Back on the latest version the folder holds V2 files and is read-only: migrate it to the new library (below).

## The new library

The personal profile keeps its library in one SQLite file, `<private-root>/data/store/world.sqlite` (the new library). It is the only way this version writes personal data; the five V2 files in `data/v2/` of earlier versions are only read, as the input of a migration. What the private root holds decides what the personal preview does:

- **A new library** (`data/store/world.sqlite` exists): the App reads and writes it.
- **V2 files and no new library** (a folder from an earlier version, or one restored with `npm run backup -- restore`): your data is shown read-only with a notice, "Your personal data has not been migrated to the new library yet. It is read-only and edits are not saved." Every save, upload, import and media task is refused with `E_STORE_MIGRATION_REQUIRED` and writes nothing; `npm run media:import` exits with code 2, and `npm run media:check` still previews. Migrate it (below).
- **No data at all**: the personal preview creates an empty new library when it starts. Builds, the public profile and the command lines never create one.
- **Files left under `data/store/` but no new library** (an interrupted migration or restore): read-only in the same way, with `E_STORE_RECOVERY_REQUIRED`; nothing creates a library over them. `npm run library:recover` lists them; after you made sure no migration or restore is running, `npm run library:recover -- --confirm` moves them into `data/store-residue/<time>/` (it never deletes them).
- **Legacy-format files that were never migrated to V2**: as described above (migrate on commit `4fd32a9` first); `store:migrate` refuses them.

Migrate a root with V2 files from `01_Web/`:

```powershell
npm run backup -- create --root <private-root> --out <new backup folder>   # first: a backup of the V2 files and media
npm run store:migrate                 # dry run: counts, kept V2 keys, unresolved list elements, comparison; writes nothing
npm run store:migrate -- --apply      # creates data/store/world.sqlite; the V2 files stay exactly as they are
```

The dry run builds the new library in memory and compares what the App would read with the V2 files. `--apply` refuses while a media task is unfinished (finish or abandon it in the recovery center first); it creates the file under the library lock, registers the media already imported, checks the library the same way after reopening it, and deletes it again if anything differs. The personal preview may keep running: it notices the new file and reloads the page, which then saves to the new library. Keep the V2 files and the backup as your copy from before the migration.

The new library saves every edit: adding footprint cities and countries, deleting hidden countries, adding Want to Go items and editing their notes, hiding and deleting them, marking as visited (including the choice of a trip with the same title), ordering and hiding countries, cities and photos, covers, and media (uploads, imports, media tasks in the recovery center, and deleting hidden media for good). The editing rules are those of earlier versions, but a save no longer reloads the page: its changes are applied where you are, so the camera, the time filters, the selection, a half-filled form and the scroll position of the other pages stay. Changes saved in another tab or by a command (`npm run media:import`) appear on an open page by themselves. While a save is in flight the globe pauses (at most 1.5 s) and then draws the result. When the record you are editing was changed elsewhere meanwhile, the editor lists the old and new values and holds the save until you choose **Keep my changes** (your fields are written over the new data) or **Use the new content**; a record deleted elsewhere can only be discarded, and a note can be copied first. A save that meets another tab's save is sent again on the new data when its own record did not change. A save whose result cannot be confirmed is retried with the same request, once at once and once after the development server answers again, and then blocks the page until a reload, so nothing is written twice. If the new library cannot be opened (another process is writing it, a format this version does not know, a file that cannot be read at all), the page shows the error; it never falls back to the V2 files.

Media in the new library follows two rules of its own:

- **The Inbox is where media comes in, not where it is kept.** Once a file is imported, its record lives in the new library: editing it in the app never changes the Inbox, and later Inbox changes do not rewrite the record. A file moved or renamed in the Inbox with the same content stays the same record (a whole folder too); a file removed from the Inbox keeps its record, its source marked missing. Folder bindings and sidecar entries (`media.json`) take effect when a file is first imported; a record moved into another city's folder keeps its place. To apply a changed sidecar or folder to records already imported, run `npm run media:check -- --reread <Inbox path>` to see the differences and `npm run media:import -- --reread <Inbox path>` to apply them.
- **The same content from two sources is two records.** Each has its own title, order and cover; they share one copy of the generated files. Uploading a photo (or a media task's file) always gives a new record, even a photo deleted before; `npm run media:import -- --reimport <Inbox path>` does the same for a file you put into the Inbox by hand.

Some Inbox changes need your confirmation before an import writes anything: a photo deleted for good appears again, a file at the same path has other content (it becomes a new record and the old one stays), or one content matches several records. The recovery center lists them next to the import with a checkbox; on the command line add `--accept-source-matches` (and `--accept-folder-bindings` for folders matched by name). `npm run media:check` only reads the new library, so it can run while the preview is open; `npm run media:import` writes under the library lock. An import of about 200 photos makes the preview pause for about 0.15 s once, while it saves them; the recovery center shows the import as processing meanwhile.

A new library created before media existed in it opens with `E_STORE_UPGRADE_REQUIRED`. Stop the preview and run `npm run store:upgrade` once in `01_Web/`: it adds the media registry and registers the media already imported, so the next import adds nothing V2 would not. A backup of that format is upgraded when it is restored.

If the check that runs after an unclean stop finds damage but the data can still be read, the new library opens read-only: the page shows your data as usual with a notice, "The new library may be damaged and is read-only. Restore it from a backup: npm run store:restore", and every save is refused with `E_STORE_READ_ONLY` and saves nothing. The same happens when damage is found while the preview runs. Restore from a backup (below) and point `STARMAP_PRIVATE_ROOT` at the restored root; `npm run library:recover` lists what the check found.

This version does not write V2 files any more. To get your data as V2 files (to archive it, or to use it with an earlier StarMap version, such as commit `e85f647`), run `npm run store:export-v2 -- --out <new folder>`. It writes the new library as the five V2 files and the media source index, lists anything V2 cannot express, and lists what a V2 `npm run media:import` of an earlier version would then add, change or remove (records of one content become one item again; records whose files are gone from the Inbox disappear). It refuses while deleted media files still wait to be removed. Keep the new library and its backups: the export never deletes anything. A private root whose `data/store/` was moved away is read-only again until it is migrated.

Back up and restore the new library with its media (`MediaInbox/` and `media/user/`; `config/`, `data/v2/` with the V2 media source index, and `operations/` are not included: the new library keeps its own media registry, and a restore checks every registered generated file against it):

```powershell
npm run store:backup -- --out <new folder>
npm run store:restore -- --from <backup folder> --to <new private root>
```

Export the new library's read model (`starmap.read-model`: every place, record, item and view setting the App reads, without the media registry, receipts or any other table only the store keeps) as one JSON file:

```powershell
npm run store:export-read-model -- --out <new file>            # everything
npm run store:export-read-model -- --out <new file> --public   # only what is marked public, and what it needs
```

The output follows the rule of the other exports (inside the private root or outside this repository, never over an existing file) and passes a full check before it is written. A public export includes the map's display settings, so the coordinate of the map's default camera becomes public; media are published without their original file names.

A backup refuses while a media task is unfinished. Under the library lock (a few seconds) it runs an integrity check and takes a consistent snapshot of the database; then it releases the lock, so the preview keeps saving, and copies the media with the rules of `npm run backup`: files outside its list of media types refuse the backup, and each copy is checked against the SHA-256 of its source. The manifest records the size and SHA-256 of every file, and the completion mark is written last. A restore checks the manifest, creates a new private root with the new library and the media, checks every media file against its SHA-256 (one mismatch fails the restore and removes the new root), runs `integrity_check` and the full check, and never overwrites anything. Copy `config/` yourself and point `STARMAP_PRIVATE_ROOT` at the new root. A backup of ten thousand photos takes a few minutes: most of the time goes to the number of files. On a private root with a new library, `npm run backup -- create` (below) uses the same implementation and says so. Every output folder must be inside the private root or outside this repository, and not inside its media or data folders. Details: [docs/local-backup.md](docs/local-backup.md).

Run one personal preview per private root: the dev server keeps the new library open. `npm run build:personal` reads the new library read-only, so it can run while the preview is open. The build keeps its data in a separate file, `data/read-model.<hash>.json`, which the page loads at start-up: deploy the whole build folder and open it through a web server, not by opening `index.html` as a file. Do not keep a library that is in use in a synced folder such as OneDrive; sync only finished backups. If the preview is killed instead of stopped, the next start runs SQLite's `quick_check` first.

The preview keeps the new library's bookkeeping small on its own: when it opens the library and after every 200 saves it removes old save receipts (a receipt is kept while it is younger than 30 days or among the newest 10,000) and old diagnostic records (the newest 50,000 within a year), in small steps after the save has answered, and returns the freed space to the file system.

## Build and verify

From `01_Web/`:

```powershell
npm run lint
npm test
npm run build:public
npm run privacy:check
npm run media:check
```

`npm test` runs every unit and script test (`src/**/*.test.ts` and `scripts/**/*.test.mjs`, plain `node --test`; it takes a few minutes). `npm run build:public` creates a static public-display build in `01_Web/dist/` without the local editor: no build contains the editor's client code, and CI refuses a public bundle that does. `npm run release:check` goes further: it requires a clean worktree, archives only Git-tracked files into a temporary clean room, installs dependencies, and runs lint, the tests, and the public build there. Those commands inherit only a sanitized environment (search path, home and temporary directories, locale, proxy settings): `STARMAP_PRIVATE_ROOT`, `VITE_*` values and tokens are not passed on, and a failing step prints the output it captured. This proves an external private layer cannot leak into a public release. Use `build:personal` only for a private deployment you control. Hidden content does not go into a personal build: hidden countries, cities, Want to Go entries, photos and drone media are left out of its data together with everything only they lead to, and only the media files of what is shown are copied. The development server still has everything, because the editor restores and deletes hidden entries.

### Caching the public build

The build follows [Cesium's own Vite setup](https://github.com/CesiumGS/cesium-vite-example): Cesium's code is bundled into a content-hashed chunk, and the files Cesium loads at run time are copied unchanged into a directory named after the installed Cesium version. A host can therefore cache `dist/` like this:

| Path | Its URL changes when | Suggested `Cache-Control` |
| --- | --- | --- |
| `index.html` | — (it names the current chunks) | `no-cache` |
| `assets/*`, including `assets/cesium-<hash>.js` | the file's content changes (the hash is in the name) | `public, max-age=31536000, immutable` |
| `cesium/<version>/*` (Cesium's `Workers`, `Assets`, `Widgets` and `ThirdParty`) | Cesium is upgraded (a new version gets a new directory) | `public, max-age=31536000, immutable` |

Cesium has a chunk of its own, so an application change that uses no further Cesium API keeps that chunk's name and every cached copy of it.

For development, run `npx playwright install chromium` and `npm run test:browser` in `01_Web/` to check language drafts, city selection, the Want to Go shortcut, media retries, conversion to travel and the mobile panels. The tests use a new temporary synthetic data directory and never touch real private data; they refuse to start when port 5173 is occupied. The checks form three groups, critical flows, media recovery and time filters, which run on their own with `--critical-flows`, `--media-recovery` or `--time-filters`; add `--shard=<current>/<total>` to rerun one CI shard. After `npm run build:public`, `npm run test:browser -- --public-smoke` checks the public build itself. `npm run perf:browser` measures the interface and scrolling with 1,000 synthetic entries; its numbers are a local development baseline, not a release gate or a CI performance threshold. Configuration and report locations are in `01_Web/README.md`.

## Updates

The bottom-right version button checks the latest [GitHub Release](https://github.com/b532459418-lab/StarMap/releases) at most once every 12 hours. A newer unseen version activates a breathing light and shows release notes plus a guarded AI-update prompt. It never overwrites your project automatically.

The button is reversible: click once to open the update page, then click it again to return to the Map or Journey view you were using.

Forks can point the checker at their own Releases by setting `VITE_GITHUB_REPOSITORY=owner/repository`.

## Project layout

| Path | Purpose |
| --- | --- |
| `01_Web/` | React, TypeScript, Vite, and Cesium application |
| `02_Assets/MediaInbox/` | Tracked neutral template for the external private Inbox |
| `03_Reference/` | Architecture, privacy, and media workflow references |
| `05_Test/` | Verification guidance |
| `docs/` | Editions and licenses, release notes, and images |

## Privacy and security

- Real tokens belong only in the external private layer or hosting environment configuration.
- Personal travel data and user media belong only in the external private layer, outside the Git repository.
- `.gitignore` is a second safety net, not the primary separation mechanism.
- Run `npm run release:check` before every public release; never push `.env.local`, private media, personal catalogs, or credentials.

## Editions and license

StarMap is one product line with three parts. Only the first one lives in this repository.

| Edition | License | Where |
| --- | --- | --- |
| **StarMap** (Core / Community Edition) | [MIT](LICENSE) | This repository. Genuinely open source, local-first, and complete on its own. |
| **StarMap Plus** | [PolyForm Perimeter 1.0.1](https://polyformproject.org/licenses/perimeter/1.0.1) plus a separate commercial license | [b532459418-lab/StarMap-Plus](https://github.com/b532459418-lab/StarMap-Plus). Source-available advanced local features. |
| **StarMap Cloud** | Proprietary | Optional hosted sync, sharing, and social services. |

The rule for where a feature goes: if a user can complete their whole personal world graph locally, without an account or a network connection, that capability belongs in this MIT repository. See [docs/editions.md](docs/editions.md).

- Every version of this repository, including all historical releases, is MIT. Nothing is relicensed retroactively.
- StarMap Core, the World Graph model and Layer Registry, lives in [`01_Web/src/worldgraph/`](01_Web/src/worldgraph/README.md).
- Upstream attribution and fork history: [NOTICE.md](NOTICE.md)
- Third-party software, data, and service terms: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)
- The StarMap name and logo are not covered by the code license: [TRADEMARK.md](TRADEMARK.md)
- How to contribute: [CONTRIBUTING.md](CONTRIBUTING.md)
