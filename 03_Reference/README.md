# StarMap References

Use this directory for durable technical, deployment, imagery-provider, and open-source release references. Licensing lives at the repository root: [`LICENSE`](../LICENSE), [`NOTICE.md`](../NOTICE.md), [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md), and the edition boundaries in [`docs/editions.md`](../docs/editions.md).

Current implementation dependencies include Cesium, Resium, React, Vite, Tailwind CSS, and Photo Sphere Viewer (which brings in Three.js). Verify current licenses and imagery-provider terms before public deployment; do not rely on assumptions copied from old conversations.

## Media Import References

| File | Purpose |
| --- | --- |
| [Media import protocol](TravelAtlas_media_import_protocol.md) | Rule priority, stop conditions, user folder convention, Agent workflow, privacy boundary, and display rules |
| `media-catalog.schema.json` | Machine-readable schema for the generated local media catalog |
| [Open-source privacy boundary](TravelAtlas_open_source_privacy_boundary.md) | Public template, local data overlay, clean-repository, and deployment boundary |
| `travel-map.schema.json` | Machine-readable schema shared by public sample and private travel data |
| `want-to-go.schema.json` | Machine-readable schema shared by the public Want to Go sample and private Want to Go data |

The three JSON Schemas describe the legacy files only (travel map and Want to Go `schema_version` 1, media catalog `schemaVersion` 2). StarMap reads and writes the five V2 files (`data/v2/` in the private layer, `01_Web/src/data/v2-sample/` for the public sample); the authoritative definition of the V2 format and its checks is [`01_Web/src/data/canonical/v2Schema.ts`](../01_Web/src/data/canonical/v2Schema.ts). There is no separate JSON Schema for V2.

## Documentation

- Public guide: [`../README.md`](../README.md)
- Media import protocol: [`TravelAtlas_media_import_protocol.md`](TravelAtlas_media_import_protocol.md)
- Open-source privacy boundary: [`TravelAtlas_open_source_privacy_boundary.md`](TravelAtlas_open_source_privacy_boundary.md)
