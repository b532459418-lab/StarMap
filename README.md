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

The **Collection** tab in the top navigation lists every place on the Want to Go layer, including hidden places, places without coordinates, and places that the map merges into a visited city. Search by name, country code, or note, filter by shown or hidden, and sort by date added, name, or country. **View on map** (在地图上查看) switches to the map, flies the camera to the place, and opens its detail card, turning the Want to Go layer back on if it was off. In the personal profile each card can also edit its note, hide, restore, or permanently delete the place; planned travel records and the public sample are read-only there.

Your places are saved in `<private-root>/data/want-to-go.local.json`, outside the source repository like the rest of your private data. If that file does not exist yet, the personal profile starts with an empty Want to Go layer rather than the sample. Travel records with `status: planned` in your travel data also appear on the Want to Go layer; they are read-only there, so change them in the travel data itself.

Public builds and `dev:public` show a neutral three-place sample instead (Nuuk, Tromsø, and Akureyri, which overlaps the sample journey to demonstrate the heart badge) and contain no add, hide, or delete controls. Forced sample mode (`VITE_TRAVEL_ATLAS_DATA_MODE=sample`) shows the same sample, with no Want to Go write controls.

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
