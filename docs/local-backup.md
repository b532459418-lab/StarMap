# Local library backup and recovery

Status: first offline implementation. A backup preserves the active V2 library and local media. Recovery creates a **new private directory**; it does not replace or automatically activate the existing library. This format is an application backup, not the future World Graph Core interchange format.

## Scope

| Included | Handling |
| --- | --- |
| The five existing `data/v2/*.local.json` data files | Byte-for-byte copy; IDs, notes, names, coordinates, hidden/order/cover state are retained. Missing files retain their normal empty-data meaning. |
| `data/v2/media-source-index.local.json` | Copied when present; index version and referenced Inbox source files are checked. |
| `MediaInbox/` source images/video and `place.json`, `country.json`, `media.json` | Preserved without conversion, importing, or inventing metadata, including supported archival media types awaiting conversion. Place pins must reference the registry. |
| `media/user/` images and video | Original copies, thumbnails, previews and old generated media of recognized formats are preserved. Catalog/variant references must have corresponding files. |

Configuration/credentials, browser storage, source code, build output, private planning documents/logs, historical `.bak`/`.tmp` files, legacy-format data and migration artifacts are outside the snapshot. Restore preserves the current runtime library, not every file in the private workspace. Credentials are configured locally after recovery. Browser language, camera and layer preferences are selected again in the new browser context.

`operations/` is also excluded: operation locks/generation, media task identities/receipts and partial/staged reception are not a backed-up task queue. Restoring a new root creates a new task-library identity only on explicit future task creation. Original tasks stay in the original root; fully published Inbox sources are included normally. Finish or review pending reception before backup. See [media recovery server foundation](local-media-recovery.md).

Only known data filenames, recognized media extensions, and named Inbox sidecars are eligible. Documentation/template files (`README.md`, `.gitkeep`), OS thumbnails and previous-write temporary files are skipped. Other files under the included regions cause a refusal rather than a silently incomplete backup. Symlinks, junctions, special files, ambiguous paths, Windows device/ADS names, traversal and case-insensitive file collisions are rejected. The tool does not inspect `config/.env.local`.

## Offline commands

Run from `01_Web/`. Stop your own personal preview and finish pending uploads/imports first. The create command refuses occupied preview ports 5173 and 5174 and never stops another process. All paths must be explicitly supplied; there is no implicit selection of the current private library. Destination parent directories must already exist. Use a separate private storage location outside the source repository and outside the source private root, such as a private backup drive.

```powershell
npm run backup -- create --root "D:/StarMap-private" --out "D:/StarMap-backups/snapshot-2026-10-03"
npm run backup -- inspect --from "D:/StarMap-backups/snapshot-2026-10-03"
npm run backup -- restore --from "D:/StarMap-backups/snapshot-2026-10-03" --to "D:/StarMap-restored"
```

`create` copies eligible files, checks their SHA-256 and byte length, rechecks the source inventory and V2/media integrity, then writes `manifest.json` last as its completion marker. A changing source or failed copy leaves an incomplete **new** directory; the source library is untouched. Stop every other writer, including command-line importers: the port check is a guard and does not implement a global filesystem lock.

`inspect` verifies the manifest/version, exact payload inventory, sizes/hashes, supported V2 schemas, place references, local media variants, source index and Inbox place pins. Output contains aggregate counts and warning categories, not personal names or JSON excerpts. A library with media but no source index retains its runtime media; it produces `SOURCE_INDEX_ABSENT` because future import replay cannot be guaranteed. Missing files that an existing index references are blocking.

`restore` without `--apply` is read-only and shows counts, sizes, warnings, new-directory mode and manual activation. Review the result before executing:

```powershell
npm run backup -- restore --from "D:/StarMap-backups/snapshot-2026-10-03" --to "D:/StarMap-restored" --apply
```

The destination must not already exist, even as an empty directory. Recovery rechecks copied hashes and integrity, then writes `restore-receipt.json` only after success. A failed recovery leaves a new incomplete directory without activation. Keep it separate and correct the cause before retrying with another fresh destination. No automatic cleanup deletes personal files.

After a successful recovery, point `STARMAP_PRIVATE_ROOT` at the new directory, configure your own credentials if needed, and start the personal profile. Check counts, Want to Go/hidden state, covers, photos and drone views before resuming editing. Keep the previous private directory as the recovery-before copy. To return to it, stop the preview and point the setting back at the previous root; edits made since recovery stay in the new root and are not merged automatically.

## Format and guarantees

```text
snapshot/
  manifest.json   # format=starmap-local-backup, version=1, createdAt, entries
  payload/
    data/v2/...
    MediaInbox/...
    media/user/...
```

Each manifest entry has a portable relative path, byte length and SHA-256. Files retain original bytes; no generated timestamps or names are injected into the V2 payload. The manifest contains private relative names and hashes and should be stored as private data. It is not encrypted. Checksums detect corruption; they do not authenticate a backup supplied by another party. JSON documents are limited to 32 MiB each and the manifest to 100,000 file entries in this initial implementation. No ZIP parser, compression or new archive dependency is involved.

The existing library is the recovery-before copy because this first mode never overwrites it. In-place replacement, merge/conflict rules, browser backup settings, compression/encryption, progress UI and automatic scheduling remain future work. In-place recovery requires coordinated shutdown, staging and an explicit durable rollback procedure before implementation; a series of per-file atomic writes cannot guarantee an atomic whole-library replacement.

## Failure categories

| Code | Meaning / next action |
| --- | --- |
| `E_BACKUP_PREVIEW_ACTIVE` | Finish writes and stop your own preview. |
| `E_BACKUP_TARGET_EXISTS` | Select a fresh destination; no existing directory will be overwritten. |
| `E_BACKUP_TARGET_PARENT` | Create/check the destination parent and its permissions. |
| `E_BACKUP_FORMAT`, `E_BACKUP_JSON`, `E_BACKUP_INTEGRITY` | Unsupported/corrupt data; inspect or select another complete snapshot. |
| `E_BACKUP_CHECKSUM`, `E_BACKUP_CHANGED`, `E_BACKUP_EXTRA_FILE` | File mismatch, concurrent change or incomplete snapshot; do not activate it. |
| `E_BACKUP_MEDIA_MISSING`, `E_BACKUP_SOURCE_INDEX`, `E_BACKUP_PIN` | Missing media/source or inconsistent mapping; correct the source through the existing editor/import workflow. |
| `E_BACKUP_PATH`, `E_BACKUP_LINK`, `E_BACKUP_COLLISION`, `E_BACKUP_PRIVATE_OUTPUT`, `E_BACKUP_OVERLAP`, `E_BACKUP_UNSUPPORTED_FILE` | Unsafe or unsupported location/entry; use a separate valid private location. |
| `E_BACKUP_LEGACY` | Use the documented legacy migration workflow before creating a V2 library backup. |
| `E_BACKUP_LIMIT` | Snapshot exceeds the first implementation's manifest size or file-count limit. |

## Verification

`npm test` includes isolated backup roundtrips with an actual synthetic media import: V2 bytes, IDs, notes, hidden/cover/order state, originals, derivatives and source index are retained, and reimport retains media identity. Tests also exercise read-only preview, existing-target refusal, tampering, missing files, invalid versions/references, portable path rules, traversal, credential exclusion and symlink/junction refusal. Fixtures are generated in temporary directories; no owner's private library is used.
