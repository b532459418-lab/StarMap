# AGENTS.md

## 本地预览 / Dev Server

StarMap 是 Vite React 项目。

每次需要本地预览时，必须在项目根目录内启动：

```bash
npm run dev:personal
```

项目根目录是当前仓库中的 `01_Web/`。

禁止事项：

1. 不要在仓库之外的目录运行 `npm run dev`；
2. 不要使用 Node API 临时启动 Vite；
3. 不要使用自定义 `.vite-cache` / `vite-dev-cache`；
4. 不要使用 `--host 0.0.0.0`，避免触发 Windows 防火墙和管理员权限弹窗；
5. 不要反复启动多个 dev server；
6. 如果 `localhost:5173` 白屏，优先检查 Vite 缓存 / 依赖预构建问题，而不是先改业务代码；
7. 如果需要强制刷新依赖，优先使用：

```bash
npm run dev:personal -- --force
```

以后启动预览时，只使用标准方式：

```bash
npm run dev:personal
```

不要再使用临时 Vite 启动脚本或自定义缓存路径。

Codex 固定使用端口 5173，DSH 固定使用端口 5174。启用 strict port；若 5173 被占用，停止并报告，不得自动改用 5174。

## Imagery Source Credential Boundary

- StarMap supports Cesium ion imagery, Tianditu imagery with Chinese labels, and the bundled low-resolution Natural Earth II fallback. Cesium remains the 3D engine; switching sources changes imagery, not the globe implementation.
- A missing online credential is supported. Open-source users provide their own `VITE_CESIUM_ION_TOKEN` and/or `VITE_TIANDITU_TOKEN`; ordinary visitors use the deployed site's configuration and never inherit the original author's values.
- Never ask for, read, echo, screenshot, log, copy, or store a complete token or key. The user enters development values directly into the external private layer's `config/.env.local` and production values directly into the hosting platform.
- Use `VITE_MAP_SOURCE=auto|cesium|tianditu|local` to select the initial source. The browser may remember a later valid choice. A green source-menu light confirms only a non-empty variable, not validity, quota, permissions, or network reachability.
- Both Vite environment values stay out of Git but are observable in a built static browser application. Use app-specific development and production credentials with provider-supported URL, asset, scope, quota, monitoring, and rotation controls.
- Verification may check only file presence, ignore coverage, non-secret status, and actual map behavior; never inspect or report the full value.

## Primary Map Implementation

- From now on, the Cesium implementation is the primary Map implementation.
- Daily map development must target `src/components/CesiumAtlasGlobe.tsx` and related Cesium components.
- The old `src/components/AtlasGlobe.tsx` react-globe implementation is legacy and frozen.
- Do not modify the legacy react-globe Map unless the user explicitly asks for legacy map changes.
- When the user says "map", "globe", "route", "city marker", or "camera", assume they mean the Cesium implementation.

## Personal Media Import

- Treat any request about uploading, importing, organizing, or adding photos or drone media as a routed media-import task. Read `../02_Assets/MediaInbox/README.md` first, then `../03_Reference/TravelAtlas_media_import_protocol.md` before execution.
- If the user only asks how to upload, explain the folder workflow and stop; do not modify files or run the import.
- If any country, city, media type, date, coordinate, privacy status, or intended use is missing or uncertain, ask one focused question and stop. Without a reliable answer, never guess or import that item; a preflight warning about unresolved data remains blocking even when the command exits successfully.
- Treat the external private layer's `MediaInbox/`, `media/user/`, `data/*.local.json`, `data/v2/`, `data/migration/`, and `config/.env.local` as private local data; never copy them into the source repository or add them to Git.
- Run `npm run media:check` before `npm run media:import`.
- Never guess an unresolved country, city, or drone coordinate, and never delete source media or generated history without explicit confirmation.
- Ordinary city photos feed City Info and City Photos. Selected drone files must be inspected immediately for embedded date, GPS, altitude, relative altitude, and camera metadata. File-derived values stay read-only; only missing values become editable. Date is required, while coordinates and altitude are optional. A drone item without coordinates may appear in Drone Media but must not create a map marker or camera target.
- Source media in `MediaInbox` is immutable. The only Agent-writable Inbox files are `place.json` (normally written by StarMap itself on upload and import), `country.json`, and city-level `media.json`; conversions and all other derivatives must stay outside Inbox.

## Public Template and Private Overlay

- Read `../03_Reference/TravelAtlas_open_source_privacy_boundary.md` before changing travel data, publication structure, or deployment.
- The tracked samples must remain neutral, runnable, and free of owner data: the V2 sample in `src/data/v2-sample/` that public mode reads, and the legacy-format `src/data/travel-map.sample.json` and `src/data/want-to-go.sample.json` it is generated from with `npm run sample:v2`.
- Personal countries, cities, routes, coordinates, display rules, and Want to Go items belong only in the external private layer (`06_private/`, or the standalone clone's configured private root): in `data/v2/` for a private folder in V2 mode, which every new private folder uses, or in `data/travel-map.local.json` and `data/want-to-go.local.json` for a folder still in the legacy format.
- The data mode is decided by `data/data-mode.local.json`, then by whether legacy files exist (see `README.md` in this directory). Never hand-edit the V2 data files, the identity manifest, or the marker; use the local editor, `npm run media:import`, `npm run identity:check`, and `npm run data-mode`. The only hand-written migration file is `data/migration/identity-decisions.local.json`, and it records decisions the user made; never decide for the user.
- Do not add built-in personal items to `droneMedia.ts`, personal coordinate tables, or tracked public media paths.
- Run `npm run release:check` before any public-release preparation. It audits privacy and rebuilds from a clean archive containing only Git-tracked files.
- This repository is public. Every commit is published, so private data must never enter the working tree in the first place; `.gitignore` and `npm run release:check` are backstops, not the boundary.

## Documentation

- Public guide: [`../README.md`](../README.md)
- Chinese guide: [`../README.zh.md`](../README.zh.md)
- Project rules: [`../AGENTS.md`](../AGENTS.md)
- Media import protocol: [`../03_Reference/TravelAtlas_media_import_protocol.md`](../03_Reference/TravelAtlas_media_import_protocol.md)
- Open-source privacy boundary: [`../03_Reference/TravelAtlas_open_source_privacy_boundary.md`](../03_Reference/TravelAtlas_open_source_privacy_boundary.md)
