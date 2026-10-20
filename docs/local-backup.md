# Local library backup and recovery

Status: first offline implementation. Personal data lives in the new library (`data/store/world.sqlite`) since 3C-4d: on such a root `npm run backup -- create` uses the implementation of `npm run store:backup`, which backs up the new library with its media: see [New library](#new-library-storebackup-storerestore). On a root that still holds the V2 files of an earlier version, it backs up those files and the media: take this backup before `npm run store:migrate -- --apply`. Recovery creates a **new private directory**; it does not replace or automatically activate the existing library. A V2 backup restores to a root that needs migrating (read-only until `npm run store:migrate -- --apply`). This format is an application backup, not the future World Graph Core interchange format.

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

## New library (`store:backup`, `store:restore`)

The new library (`<private-root>/data/store/world.sqlite`, see the root README) is one SQLite file plus the media. Back it up and restore it from `01_Web/` with:

```powershell
npm run store:backup -- --out "D:/StarMap-backups/store-2026-10-15"
npm run store:restore -- --from "D:/StarMap-backups/store-2026-10-15" --to "D:/StarMap-restored"
```

`npm run backup -- create --root <private-root> --out <new folder>` on a new-library root uses the same implementation and says so in its output (`"mode": "store"`, `"delegatedTo": "store:backup"`); it does not require the preview to be stopped. `npm run backup -- inspect` and `restore` refuse a new-library backup with `E_BACKUP_STORE_FORMAT` and point to `store:restore`.

| Included | Handling |
| --- | --- |
| The new library | A consistent `VACUUM INTO` snapshot `world.sqlite`, taken after `quick_check` passed. |
| `MediaInbox/` and `media/user/` | The rules of the V2 backup above: the same allowlist of media types and Inbox sidecars, the same skipped files, portable paths only, links and junctions refused, a file outside the allowlist refuses the backup. |

Not included: `config/`, `data/v2/` (the V2 files and, since 3C-4c, the V2 media source index: the new library keeps its own media registry, and the index goes stale once the new library imports or deletes media), and `operations/`.

### Backup

1. Refused while a media task is unfinished (`E_MEDIA_JOB_PENDING`).
2. Under the library operation lock: `quick_check`, the snapshot, and a mark `operations/store-backup/<backup id>.json`. The lock is held for seconds.
3. The lock is released, so the preview keeps saving. While the mark exists, the file removals that media deletions queue in `pending_file_ops` wait, so every file the snapshot refers to stays; the next media write after the backup runs them. A backup that is killed leaves its mark behind: removals stay paused until `npm run library:recover` lists the mark and `npm run library:recover -- --confirm` (once no backup is running) removes it and runs them.
4. The media files are listed and copied into `payload/`: each file is hashed (SHA-256), copied exclusively and the copy hashed again; a difference fails the backup. Files added after the snapshot are harmless extras.
5. The snapshot's media references are checked against the copies: every original and variant under `/media/user/`, and every Inbox `place.json` naming a place of the library. Media paths outside `/media/user/` are not files of the private root: they are counted in the warning `MEDIA_OUTSIDE_USER_MEDIA`. The snapshot's media registry is checked too: every generated file it records must be among the copies with the SHA-256 it records (`E_BACKUP_MEDIA_REGISTRY` otherwise; the content of a folder already queued for removal is skipped). Content-addressed folders no registry row names, left by an interrupted import, are counted in the warning `MEDIA_UNREGISTERED`.
6. `manifest.json`, then the completion mark `COMPLETE.json` last. Any failure removes the new backup folder.

```text
store-backup/
  world.sqlite      # the snapshot
  payload/          # MediaInbox/..., media/user/... (backups made before 3C-4c also hold data/v2/media-source-index.local.json)
  manifest.json     # format starmap.store-backup, formatVersion 2: library id, revision, row counts,
                    # the snapshot's size and SHA-256, and media { count, bytes, warnings, entries[path, bytes, sha256] }
  COMPLETE.json     # the manifest's SHA-256; written last
```

The output folder must not exist, must be inside the private root or outside this repository, and must not be inside the private root's `MediaInbox/`, `media/` or `data/`. Output lines carry counts, sizes, hashes and output paths, never media file names (they name places).

### Restore

`store:restore` checks the completion mark, the manifest and the snapshot's SHA-256, and that `payload/` holds exactly the media files the manifest lists, each an allowlisted media path. It then creates the new private root (which must not exist), copies the snapshot and every media file, checking each copy against its SHA-256 in the manifest, records which backup the library came from (one layer, replaced by the next restore), and runs `integrity_check`, the full check of the library (the media registry included) and the media reference check, then checks the media registry against the restored files as the backup did: the registry and the generated files correspond one to one. Any failure, a single media file included, removes the new root. Copy `config/` yourself and point `STARMAP_PRIVATE_ROOT` at the new root. Backups made before media were included (format version 1, the database only) still restore, without media. A backup of a library from before the media registry (3C-4b, with the V2 media source index) is upgraded in the new root as `npm run store:upgrade` would, its registry seeded from the restored files and index.

If the preview shows the new library as damaged and read-only, restore the latest backup into a new root this way.

At the real scale of the benchmark (`npm run store:bench:mode`: 10,000 media items, about 23,000 files) a backup took 2.5 to 4 minutes and a restore about 2 minutes on a development machine, for 0.8 GB as for 3.3 GB of media: the number of files, not their size, decides.

| Code | Meaning / next action |
| --- | --- |
| `E_MEDIA_JOB_PENDING` | Finish or abandon the media task first. |
| `E_TARGET_EXISTS`, `E_TARGET_OVERLAP`, `E_PRIVATE_OUTPUT` | Choose a new folder outside the media and data folders, inside the private root or outside the repository. |
| `E_STORE_CORRUPT` | `quick_check` failed: no backup was made. Restore an earlier backup. |
| `E_BACKUP_UNSUPPORTED_FILE`, `E_BACKUP_LINK`, `E_BACKUP_PATH`, `E_BACKUP_COLLISION` | An unsupported, linked or non-portable file in the media folders. |
| `E_BACKUP_MEDIA_MISSING`, `E_BACKUP_SOURCE_INDEX`, `E_BACKUP_PIN` | The library refers to media that is missing, or the index or a folder pin is inconsistent. |
| `E_BACKUP_MEDIA_REGISTRY` | A generated file the media registry records is missing or has other content. `npm run media:check -- --verify` lists them; restore an earlier backup or re-import the media. |
| `E_BACKUP_INCOMPLETE`, `E_BACKUP_MANIFEST`, `E_BACKUP_HASH`, `E_BACKUP_MEDIA_FILES` | An unfinished, changed or damaged backup: do not use it. |
| `E_RESTORE_CHECK` | The restored library failed its checks; the new root was removed. |

## Verification

`npm test` includes isolated backup roundtrips with an actual synthetic media import: V2 bytes, IDs, notes, hidden/cover/order state, originals, derivatives and source index are retained, and reimport retains media identity. Tests also exercise read-only preview, existing-target refusal, tampering, missing files, invalid versions/references, portable path rules, traversal, credential exclusion and symlink/junction refusal. The new-library backup has its own tests: media copied with each size and SHA-256 and restored byte for byte, a damaged, missing or extra media file or a crafted manifest path failing the restore and removing the new root, an unfinished media task and unsupported files refusing the backup, the lock released before the media copy with deletions paused meanwhile, a version 1 backup still restoring, the V2 media source index left out, a generated file whose content differs from the registry refusing the backup, and the registry and the generated files corresponding after a restore. Fixtures are generated in temporary directories; no owner's private library is used.
