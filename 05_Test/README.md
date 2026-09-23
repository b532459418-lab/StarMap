# StarMap Verification

## Required Commands

Run from `../01_Web/`:

```powershell
npm run lint
npm test
npm run build:public
npm run privacy:check
npm run media:check
```

Before a public release also run `npm run release:check` from PowerShell or cmd (not Git Bash; its GNU `tar` misreads Windows drive letters).

## Manual Smoke Test

- Map opens with Cesium imagery or the configured fallback.
- The dock Layers button opens the layer panel; toggling Travel hides and restores country and city markers without reloading the globe, and the choice survives a page reload.
- Public profile (`npm run dev:public`): the layer panel lists Travel and Want to Go and each toggles independently. Nuuk and Tromsø show hollow want-to-go markers, Akureyri shows its travel marker with a heart badge, and the status pill reads `5 mapped cities · 4 journey route segments · 3 want-to-go`. Clicking a want-to-go marker opens its detail card with no Hide button; the panel has no add entry and no hidden-items row.
- With Travel hidden, Akureyri becomes a hollow want-to-go marker and the status pill reads `0 mapped cities · 0 journey route segments · 3 want-to-go`.
- Personal profile (`npm run dev:personal`): **Add a place you want to go** adds a city (online search or manual coordinates) or a whole country, and its marker appears; adding the same place again shows the already-on-the-list error. The detail card shows the note and a Hide button; a hidden place moves to the panel's hidden-items list, where Restore brings it back and Permanently delete removes it after confirmation.
- Collection (top navigation) collapses both sidebars like Journey and stays open after a page reload. In `dev:public` it lists the three sample places with stats Total 3 / On map 3 / Hidden 0 / No location 0 / From travel log 0; every card has the Sample tag (样例) and **View on map** (在地图上查看), and there are no write buttons, no Hidden filter, and no add button. Searching `极光` leaves Tromsø, searching `is` leaves Akureyri, and the three sorts reorder the cards.
- **View on map** switches to Map, flies the camera to the place, opens its detail card, and opens the sidebars. With the Want to Go layer turned off first, the layer is switched back on and the choice survives a reload. Closing the detail card does not move the camera.
- Collection in `dev:personal`: the stats match the cards; planned travel records show **From travel log · read-only** (来自旅行记录 · 只读) with no write buttons, and entries without coordinates show **No location** (无坐标) and no View on map. Edit note saves and survives the reload, and saving an empty note removes it. Hide adds the Hidden tag (已隐藏) and removes View on map; the Hidden filter lists only hidden places; Restore brings a place back; Permanently delete removes a hidden place after confirmation. The add button opens the same dialog as the layer panel. A place with the same name as a visited city (for example Reykjavik, IS) is listed on its own, and hiding it removes the heart badge from the map. With `?data=sample` the Collection shows the sample with no write controls.
- Country and city selectors update camera focus and InfoCard content.
- Map, Journey, and Collection navigation works; the bottom version button opens the update page and a second click returns to the previously active Map, Journey, or Collection view.
- Journey Year Cards and Timeline switch correctly.
- A city with local drone records opens its Drone Media entries and 360 viewer.
- Short viewport heights keep the Drone Media card readable while Memory Cards remain internally scrollable.
- Night World overview keeps the globe center fixed and renders the authored celestial layer; Day removes it cleanly.
- Reset clears selection and restores Globe Scale to `3.25`.
- A clean Media Inbox passes `npm run media:check`; imported city photos appear in City Info and Memory Cards after preview restart.
- Selecting drone files immediately displays embedded date, GPS, altitude, relative altitude, and camera metadata. Only missing values are editable; date is required, while coordinates and altitude are optional. Items without coordinates join Drone Media without creating a map marker or camera target.
- Landscape and portrait photos both fit completely inside the large Viewer without clipping.
- Fast mouse movement produces a direction-aware comet tail over the existing pointer glow; the tail does not intercept Cesium drag, zoom, country, or city interactions and is absent under reduced-motion preferences.
- With the private local travel file present, the owner's country list and configured overview target remain unchanged.
- With `VITE_TRAVEL_ATLAS_DATA_MODE=sample`, the application runs independently on the neutral North Atlantic sample and exposes no personal Drone Media.
- `npm run privacy:check` confirms no current private Inbox, local data, generated media, local catalog, or real environment file is tracked.

## Documentation

- Public guide: [`../README.md`](../README.md)
- Web workspace: [`../01_Web/README.md`](../01_Web/README.md)
- Media import protocol: [`../03_Reference/TravelAtlas_media_import_protocol.md`](../03_Reference/TravelAtlas_media_import_protocol.md)
- Open-source privacy boundary: [`../03_Reference/TravelAtlas_open_source_privacy_boundary.md`](../03_Reference/TravelAtlas_open_source_privacy_boundary.md)
