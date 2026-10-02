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
- Privacy audit and public/private data separation designed for open-source reuse.

## Quick start

Requirements: Git and a current Node.js LTS release compatible with Vite 8.

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

Known editing and location-search failures follow the interface language. If an edit returns an unreadable response, its result may be unknown: reload to check your data before retrying. A partially saved conversion also requires a reload before another attempt. Media upload errors distinguish empty or oversized files, invalid images, unusable names and incorrect panorama ratios. Import errors identify preflight or import execution failures and preserve the original diagnostics. Check the Inbox and media list before uploading again after an import failure. Diagnostic details retain their original text.

City creation uses Cesium ion geocoding first when the personal token is configured with the `geocode` public scope. If ion is unavailable, has no result, or exceeds nine seconds, StarMap falls back to an explicitly triggered, country-filtered OpenStreetMap lookup. The interface never spins indefinitely: users can retry with the local/English city name or switch to manual latitude and longitude entry.

When drone files are selected, StarMap immediately reads available EXIF/XMP metadata and displays it per file. Values found in the file are locked as file-derived facts. Only missing values become editable; a missing date must be supplied, while coordinates and altitude can be left blank.

For bulk media, follow the tracked `02_Assets/MediaInbox/` template but place real source files under the external private layer's `MediaInbox/`, then run:

```powershell
npm run media:check
npm run media:import
```

The importer never rewrites Inbox originals. Personal source media, generated derivatives, local travel records, editor state, and `.env.local` stay in the external private layer and never enter the source repository.

## Places you want to go

The Want to Go layer marks places you have not been to yet. The map layers button in the bottom dock (地图图层, a separate button from the imagery-source menu) opens the layer panel, where the Travel and Want to Go layers can be shown or hidden independently. The browser remembers the choice across sessions.

In the personal profile (`npm run dev:personal`):

- **Add**: the layer panel ends with **+ Add a place you want to go** (添加想去的地方). Choose a country first, then search for a city online (the same Cesium ion / OpenStreetMap lookup used for city creation) or enter its name and coordinates manually; you can also add the whole country. An optional note records why you want to go. Adding the same place twice is refused with a notice that it is already on the list.
- **Hide**: click a want-to-go marker to open its detail card, then choose **Hide** (隐藏). Hiding removes the marker from the map but keeps the entry.
- **Restore or delete**: hidden places are listed under **Hidden N items** (已隐藏 N 项) below the Want to Go toggle in the layer panel. Each one can be restored (恢复) or permanently deleted (彻底删除). Only hidden places can be deleted, and deletion cannot be undone.

When a place you want to go is also a city you have visited, the city keeps its travel marker and gains a heart badge. Hide the Travel layer and the same place appears as a hollow want-to-go marker.

The **Collection** tab in the top navigation lists every entry on the Want to Go layer, one card per entry, including hidden entries, places without coordinates, and places that are also visited cities (the map draws each place once, with a heart badge when it is in both layers). Search by name, country code, or note, filter by shown or hidden, and sort by date added, name, or country. **View on map** (在地图上查看) switches to the map, flies the camera to the place, and opens its detail card, turning the Want to Go layer back on if it was off. In the personal profile each card can also edit its note, hide, restore, or permanently delete the place; planned travel records and the public sample are read-only there, apart from **Mark as visited** for planned records.

Once you have been to a place, **Mark as visited** (标记为去过) turns it into a travel record in the personal profile. The button sits next to **View on map** on Collection cards and next to **Hide** on the map detail card. Enter the visit date yourself (the end date and trip title are optional); the city joins your travel records under the country you already use for that country code, and the want-to-go entry is removed unless you tick **Keep on the Want to Go list** (保留在想去列表（还想再去）), in which case the visited city shows the heart badge. Planned travel records can be marked as visited the same way: the record itself becomes a visited one with the dates you enter, and no new record is added. A whole country or a place without coordinates must first be narrowed down to a city with coordinates; its button is disabled and the reason is shown. A city that is already in your travel records has the button disabled with that reason (the editor also refuses such a request without writing anything); hide or delete the want-to-go entry instead. The want-to-go note is not copied into the travel record. After a successful conversion the page reloads on the new city, and the Travel layer is switched back on if it was off.

Your places are saved in `<private-root>/data/v2/want-to-go.local.json`, outside the source repository like the rest of your private data. If that file does not exist yet, the personal profile starts with an empty Want to Go layer rather than the sample. Travel records with `status: planned` in your travel data also appear on the Want to Go layer; apart from **Mark as visited** they are read-only there, so change anything else in the travel data itself.

Public builds and `dev:public` show a neutral three-place sample instead (Nuuk, Tromsø, and Akureyri, which overlaps the sample journey to demonstrate the heart badge) and contain no add, hide, delete, or Mark as visited controls. Forced sample mode (`VITE_TRAVEL_ATLAS_DATA_MODE=sample`, or `?data=sample` in development) previews the public site: it shows the same sample, and the local editor is off even in the personal profile, so no editing control is rendered.

## Existing data in the legacy format

The personal profile reads only the current (V2) data format in `<private-root>/data/v2/`, and a new private folder starts with an empty map. A private folder created before that holds its data in the legacy format, which StarMap no longer reads. Until you migrate it, the map shows a migration notice, the local editor refuses to save, and the media import refuses to run, so nothing is written next to the unmigrated data. StarMap never migrates, moves, or rewrites your files by itself.

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

Resolve everything the dry run asks you to decide before applying. After the migration the legacy files, and the `data/data-mode.local.json` marker of earlier versions, are leftovers that StarMap ignores; keep or delete them. If you do not need the old data at all, move the four legacy files out of `data/` instead. The full steps, the decisions file, and what the migration means for media are in [01_Web/README.md](01_Web/README.md#migrate-legacy-format-data) (Private Data Format).

## Build and verify

From `01_Web/`:

```powershell
npm run lint
npm run build:public
npm run privacy:check
npm run media:check
```

`npm run build:public` creates a static public-display build in `01_Web/dist/`. `npm run release:check` goes further: it requires a clean worktree, archives only Git-tracked files into a temporary clean room, installs dependencies, and runs lint, the tests, and the public build there. This proves an external private layer cannot leak into a public release. Use `build:personal` only for a private deployment you control.

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
