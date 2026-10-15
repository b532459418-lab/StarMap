# StarMap Assets

## Boundary

- The legacy `SourceMedia/` continuity copy was retired after the private `MediaInbox` workflow became the canonical source-media boundary.
- The real media inbox is `<private-root>/MediaInbox/` in the external private layer (`STARMAP_PRIVATE_ROOT`, or the ignored `06_private/` fallback), never this repository. The tracked `MediaInbox/` here holds only its instructions and the neutral `_country-template/`. Source media is immutable; only StarMap's `place.json` folder bindings and the city-level `media.json` drone metadata sidecars may be created or updated there (`country.json` is an optional legacy mapping).
- Browser-ready personal media is generated under `<private-root>/media/user/` and remains local-only. Each supported still image gets a content-addressed folder `media/user/<16-hex hash>/` with `original.<ext>`, `thumb.webp` (640 px) and `preview.webp` (2400 px), so list screens never decode full-resolution files. The personal dev server serves it at `/media/user/`; `npm run build:personal` copies only the files of media its pages show.
- `01_Web/public/media/user/` and `02_Assets/PrivateData/` stay in `.gitignore` as safeguards for folders of earlier versions; StarMap no longer writes there.
- The previous workspace remains the short-term rollback source and was not changed during migration.

## Bulk Import

Users copy `_country-template/`, rename it to a StarMap country, create one folder per city, and place that city's media into its `photos/` and `drone/` branches. If any country, city, media type, coordinate, privacy status, or intended use is uncertain, the Agent asks before acting and leaves the item unimported until it has a reliable answer. From `01_Web/`, the Agent runs `npm run media:check` before `npm run media:import`.

The complete folder contract, conversion rules, metadata requirements, and no-delete behavior are documented in the [media import protocol](../03_Reference/TravelAtlas_media_import_protocol.md).

## Public Release Rule

StarMap is an open-source website shell. Personal travel media never enters the public template. Only explicitly licensed or generated sample assets may be included in a clean public repository; see the [open-source privacy boundary](../03_Reference/TravelAtlas_open_source_privacy_boundary.md).

## Documentation

- [Public guide](../README.md)
- [Web workspace](../01_Web/README.md)
- [Media Inbox](MediaInbox/README.md)
- [Import protocol](../03_Reference/TravelAtlas_media_import_protocol.md)
- [Open-source privacy boundary](../03_Reference/TravelAtlas_open_source_privacy_boundary.md)
