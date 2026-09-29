# StarMap Media Inbox

This tracked directory documents the single user-facing media workflow and provides a neutral template. Real personal photos and drone media belong in the external private layer's `MediaInbox/`, never in this Git repository.

## One Request Is Enough

Users do not need to memorize commands. Ask:

> 请阅读 StarMap 的相关规则，并告诉我如何上传照片。

> Read StarMap's project rules and tell me how to import my photos.

The Agent must explain the folder placement first. It must not modify files or run the import unless the user also asks it to perform the import.

## User Workflow

1. Copy `_country-template/` and rename the copy to a country already present in StarMap, for example `Iceland` or `冰岛`.
2. Rename `example-city/` to a city already present in that country, for example `Reykjavik` or `雷克雅未克`. Add one city folder for every additional city.
3. Put ordinary city photos in `<city-name>/photos/`.
4. Put that city's drone photos, 360 panoramas, and drone videos in `<city-name>/drone/`. Do not create more type folders.
5. Ask the Agent to inspect and import the delivery. The Agent performs the checks and tells the user what, if anything, still needs clarification.

```text
MediaInbox/
└─ Iceland/
   ├─ place.json              written by StarMap: binds the folder to a place id
   ├─ country.json            optional legacy country mapping
   └─ Reykjavik/
      ├─ place.json           written by StarMap: binds the folder to a place id
      ├─ photos/
      ├─ drone/
      └─ media.json           optional Agent-authored drone metadata
```

Country and city folders must refer to places that already exist in StarMap. Add a new country or city in StarMap first (for example with the local editor), then import its media.

## How Folders Are Matched

The importer matches folders against the place registry `<private-root>/data/v2/places.local.json`:

- **Country folder**, in this order: `place.json` (`{ "placeId": "<country place id>" }`); a legacy `country.json` whose `countryId` is an old country key of that place; the folder name, compared with the country's Chinese name, English name, or ISO code.
- **City folder**, in this order: `place.json`, which must name a city of that country; the folder name, compared with the Chinese and English names of that country's cities.
- Names are compared after normalization: case, spaces, `_`, `-`, Unicode composition, and Latin accents are ignored, so `Vik` matches `Vík`.
- No match or more than one match stops the import with a message. The importer never guesses and never creates a place.
- When a folder was matched by name or by a legacy `country.json`, `npm run media:import` writes `place.json` into it, but only when the whole import has no errors; `npm run media:check` only lists these folders. From then on the folder stays bound to that place even if the place is renamed. Folders that already have `place.json` are left alone.
- Uploads from the local editor put files into `MediaInbox/<country>/<city>/photos/` or `drone/` using the English name (or the Chinese name when there is none) and write `place.json` into new folders. When two cities in the same country have the same name, the second one gets the folder `<name> (<last 8 characters of its place id>)`.
- Each media item's id is `media-` plus the first 16 hexadecimal characters of the SHA-256 of the source file, and its generated files live in `media/user/<same 16 characters>/`. Renaming a place, moving a file to another city folder, or changing a drone item's kind keeps its id and path, so its order, cover, and hidden state follow it. An explicit `id` in `media.json` still takes precedence.

A private folder that still holds legacy-format data it has not migrated cannot import media: `npm run media:check` and `npm run media:import` stop with exit code 2 and explain how to migrate (see [Legacy-format data](../../01_Web/README.md#legacy-format-data)). After the migration, a legacy `country.json` still resolves through the place's old country key, as described above.

## Agent Workflow

1. Read the project media-import route in `AGENTS.md`, then read the full [media import protocol](../../03_Reference/TravelAtlas_media_import_protocol.md).
2. Confirm that every file has a reliable existing country and city. For drone media, read embedded metadata first and confirm the media type, date, and resolution. Coordinates and altitude improve map behavior but are optional.
3. If any country, city, media type, date, coordinate, privacy status, or intended use is missing or uncertain, ask the smallest necessary question and stop. Without a reliable answer, do not guess, copy, convert, catalog, or import that item.
4. From `01_Web/`, run `npm run media:check`. Any `需要处理` result or warning caused by unresolved required data blocks the import, even if the command exits successfully.
5. Only after a clean preflight, run `npm run media:import`. The importer creates hash-stable `thumb`, `preview`, and `original` tiers outside the Inbox; restart the preview and verify City Info, City Cards/Photos, Drone Media, and the 360 Viewer as applicable.
6. Finish with `npm run privacy:check`, `npm run lint`, and `npm run build:personal`, then report imported counts and unresolved items. Before any public release, run `npm run release:check` separately from a clean source worktree.

## Source Preservation and Sidecars

Original media in `MediaInbox` is immutable by default: never move, rename, overwrite, delete, or edit it. The only deletion exception is an explicit, confirmed **Delete hidden media** action in the local editor; it removes the selected hidden source files, their generated web variants, sidecar entries, and catalog records. Three private control files are the only Agent-writable exceptions:

- `<country>/place.json` and `<country>/<city>/place.json` bind a folder to a place id (`{ "placeId": "…" }`). StarMap normally writes them itself on upload and import. Write one by hand only to resolve a reported ambiguity, with a place id taken from `data/v2/places.local.json`.
- `<country>/country.json` maps an ambiguous country folder to an existing legacy `countryId`.
- `<country>/<city>/media.json` records drone type and capture metadata using `media.example.json` as the shape reference. An entry may also carry `placeId` (a city place id) to assign one file to another city; the legacy `countryId` + `cityId` pair is still accepted. Giving both and having them disagree is an error.

These JSON files are metadata, not media derivatives. Converted, resized, optimized, or otherwise derived media must never be written into the Inbox. The editor's `.bak` backups of these files are ignored by the importer.

## Supported Inputs and Stop Conditions

- Automated import supports JPEG, PNG, WebP, AVIF, MP4, and WebM.
- Supported still formats are automatically oriented and optimized into a `640 px` WebP thumbnail plus a `2400 px` WebP viewer preview while retaining the original tier. HEIC, HEIF, TIFF, RAW, and MOV are not converted by the current importer; leave them unchanged, explain the limitation, and ask before separate conversion work.
- Ordinary city photos need no extra metadata. A filename beginning with `cover` becomes the preferred City Info image.
- Drone items need a reliable kind, date, and resolution before they become active Drone Media. The Agent must read EXIF/XMP first and may write the sidecar for missing facts, but must ask rather than invent them. A `panorama360` still must be close to the standard 2:1 equirectangular ratio; mismatches are blocked with guidance to select **Aerial photo** or provide the correct panorama. Geographic position and altitude are optional: an item without coordinates can appear in Drone Media but does not create a map marker or camera target.
- Unknown countries, unknown cities, unresolved files, or media placed outside `photos/` and `drone/` must remain unimported.

## Privacy Boundary

- `<private-root>/MediaInbox/<real-country>/`: private source delivery and sidecars; physically outside the source Git repository.
- `<private-root>/media/user/`: generated website media; physically outside the source Git repository.
- `<private-root>/data/`: personal travel data, editor state, and media catalogs in `data/v2/` (legacy-format `data/*.local.json` files, if any, are read only by the migration tool); physically outside the source Git repository.
- `_country-template/`, rules, schema, and scripts: safe to publish with the open-source repository.

Never place credentials, tickets, identity documents, hotel addresses, booking references, or private family material in the Inbox. Never add private Inbox files, generated user media, or local catalogs to Git.

## Documentation

- Public guide: [`../../README.md`](../../README.md)
- Project rules: [`../../AGENTS.md`](../../AGENTS.md)
- Assets boundary: [`../README.md`](../README.md)
- Full Agent protocol: [`../../03_Reference/TravelAtlas_media_import_protocol.md`](../../03_Reference/TravelAtlas_media_import_protocol.md)
- Open-source privacy boundary: [`../../03_Reference/TravelAtlas_open_source_privacy_boundary.md`](../../03_Reference/TravelAtlas_open_source_privacy_boundary.md)
