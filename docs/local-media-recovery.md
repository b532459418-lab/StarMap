# Local media tasks and recovery

RD-07 provides durable reception, full-Inbox import plans and sealed completion records in the personal development profile. Photo and drone panels create fixed-target tasks, and a shared bilingual recovery center discovers server records at startup, focus and explicit checking. Browser storage is not the task authority. A catalog hit alone is not proof of completion.

## Using the recovery center

Choose files in the city photo or drone editor. Drone metadata keeps its existing file-derived locks and required date. Receiving files creates a pending task; it does not start import. Open **Media tasks**, review the complete Inbox scope, then confirm and import. The preview includes other cities, catalog changes, pins, generated outputs and restored display/order effects. Never-started files can be explicitly reselected by their original name and size. Partial import requires acknowledging the received and unsent counts; completing that task leaves unsent intents recorded and ends their resumability.

Refresh, close/reopen a panel, switch languages or start a fresh browser session to read durable facts. These actions do not retry uploads or imports. A lost response triggers only a read; if a completed receipt exists, it shows history. Unknown or interrupted stages require review. **Pause for now** keeps records and sources, releases the in-page operation permit and allows ordinary editing; new media tasks and media deletion still wait. Completed tasks offer an explicit page reload and record close, without removing sources or replaying later hide/order choices. Opening the recovery center writes nothing.

## Coordination and storage

Every local-editor write and `media:check` / `media:import` share a filesystem operation lease under `<private-root>/operations/`. Competing operations are rejected, without queuing or automatic retry. The editor explicitly passes its verified lease to its importer child process. An interrupted holder leaves its lock for review; neither age nor PID releases it. Automatic orphan-lock recovery is not implemented. Do not remove a lock to bypass unknown side effects.

CLI preflight changes only coordination generation records; travel data, media and task records remain unchanged. Task GETs and POST preview write nothing, including coordination records. A generation change during their read causes a conflict. This coordinates participating editor/CLI operations, not arbitrary external writers. Before and after import, the server also checks immutable input snapshots and expected output hashes.

Tasks live in `operations/media-import/v1/` with a schema, a UUID library instance bound to the canonical private root, UUID task/file/operation IDs and monotonic revision. Missing storage means an empty read. Corrupt, future-version, copied-root and unsafe linked records are preserved and blocked. One unfinished batch per library fixes its original country, city, kind and file intents. Pause preserves the task: ordinary editing is available, while other media uploads/imports/deletions remain blocked. Explicit reception of another intended file resumes that task.

## Development API

Prefix: `/__travelatlas/editor/media/jobs`. Every endpoint requires the personal, non-forced-sample profile, a loopback socket, `x-travelatlas-local-editor: 1`, and an allowed HTTP localhost origin when Origin is supplied. Requests from a `?data=sample` page are refused. Public mode registers no private endpoints. Responses are not cached and exclude canonical root bindings, absolute paths, staging locations and lease tokens.

| Endpoint | Contract |
| --- | --- |
| GET prefix | `{ ok, libraryId, jobs }`; a present or unclassifiable lock returns a non-actionable processing/review summary. No storage is created. |
| GET prefix/:jobId | `{ ok, libraryId, job }`, with read-only source/pin/sidecar/index checks. Partial, missing, changed or already-imported evidence needs review. |
| POST prefix | JSON `{ countryId, cityId, kind, files: [{ fileName, bytes, metadata? }] }`. Target IDs must resolve to an existing city and its country. Returns a server-generated task. |
| POST prefix/:jobId/files/:fileId | Raw bytes; Content-Length equals the intended size. Query: `libraryId`, `revision`, UUID `operationId`, full declared `sha256`. Metadata comes from the stored intent. |
| POST prefix/:jobId/pause | JSON `{ libraryId, revision }`; preserves the unfinished task and originals. |
| POST prefix/:jobId/preview | JSON `{ libraryId, revision, selectedFileIds }`; zero-write full-Inbox plan with digest, blockers and summary. |
| POST prefix/:jobId/import | JSON `{ libraryId, revision, selectedFileIds, operationId, planDigest }`; revalidates the acknowledged plan under the shared lease, records stages and completion. |
| POST prefix/:jobId/close | JSON `{ libraryId, revision }`; closes a completed record while retaining sources, intent and receipt. |

Kind is `photo`, `aerialPhoto` or `panorama360`. Drone metadata needs a real `YYYY-MM-DD` date; paired latitude/longitude and finite altitudes are optional. Title fields are normalized at creation. Missing dates are refused, not inferred. Each file is at most 250 MiB; batches contain at most 100 files with unambiguous names, each no longer than 120 characters. Raw originals are never converted in Inbox.

Reception persists `receiving`, stages outside Inbox, verifies size/hash, flushes and fully decodes the image, records `staged`, then publishes the complete file with a same-volume no-replace hard link. Place pins and drone sidecar are verified before persisting `received` and replying. Panorama aspect ratio is checked with EXIF orientation. Publication failures or partial reception retain the actual stage and need review; there is no fallback to prefix-copying into Inbox. Existing destinations are preserved. Legacy upload endpoints remain compatible, but the active photo/drone panels use durable tasks.

A lost successful reception response can be replayed with the same file/operation/hash/size/library intent and the original revision before import begins. The server rechecks the receipt and source and returns the existing result without consuming the stream or rewriting task/media files; the coordination lease still advances generation. Changed operation/hash, future revisions and uncertain receipts are refused. Other mutations need the current revision. `files[].canReceive` and GET `canPreview` are advisory hints. `canImport` becomes true only in a non-blocked preview response; actual writes still acquire a lease and revalidate the complete plan.

## Import confirmation and historical completion

The importer operates on the **whole Inbox**. The preview lists all sources and cities, added/updated/removed catalog IDs, place pins, expected generated files and the selected task's editor order/restoration effects. `selectedFileIds` must explicitly include every received file of the task; unreceived intents may remain. Choosing fewer already received files cannot exclude their Inbox bytes from a whole-library import. Unknown reception results, missing metadata, unsafe links, ownership/type/content-ID conflicts, unknown catalog/index versions, mismatched source mappings and corrupt existing outputs block application. The server never silently narrows the plan to the open city.

The digest includes relevant Inbox, V2 data and generated inputs, plus expected semantic results. V2 generator timestamps/formatting are excluded; Inbox control bytes are exact. A changed plan or task revision needs a new preview. Preview computes expected derivatives in memory, but writes no files. The server checks the prospective completion record's schema and conservative size before starting: a record may hold at most 10,000 media IDs/output entries and must fit 1 MiB.

Before any import side effect, the task records `started` with the immutable operation ID, original revision, selection and plan digest. It then records `generated`, `pins`, `catalog`, `index` and `editor`. Source/control stability, catalog/index/editor results and all planned output hashes must agree before a receipt and `completed` phase are atomically saved in the same task file. The receipt has time, affected media IDs, restored IDs and file hashes. Its SHA consistency seal binds task/file/operation facts; it is not an authentication signature or a multi-file transaction.

An unsealed import remains `needs_review`, including the window where all side effects happened but the final record did not. No automatic replay or cleanup follows. A sealed operation may be replayed only with its original library/operation/revision/selection/digest; it returns the old result without rewriting task, catalog, index, editor state or media. Coordination generation still advances. Later hiding, sorting or deleting is a separate user decision: historical completion stays completed/closed and changed resources appear as warnings. Neither GET nor repeat import restores those choices.

`close` is available only after sealed completion, retains evidence and original files, and is idempotent once closed. Completed/closed records no longer block another task or ordinary media operations; paused or uncertain tasks still do. Unreceived intents in an explicitly completed partial batch remain recorded and cannot be resumed through the closed operation. No retransmission, cleanup or uncertain-operation repair endpoint exists. Tests use fresh synthetic roots and generated JPEGs. The recovery UI is integrated. See the current verification section below for runtime evidence and remaining limits.

## Backup boundary and remaining acceptance

Offline backup includes V2 data, Inbox sources/sidecars and generated media. It excludes operation locks, generation records, task identities/receipts and staging. Restoring to a new directory does not restore the original task queue; it obtains a new task-library identity only when a task is explicitly created. Pending tasks and partial reception remain in the original root. Finish or review them before backup. See [backup and recovery](local-backup.md).

This foundation is not a multi-file transaction or a power-loss guarantee. Linux compatibility, power loss, abrupt termination at every reception stage, orphan-lock recovery, real-device and real-library acceptance remain pending.

## Local verification (2026-10-05)

The complete 28-case browser regression passed in one run with exit code 0. The preceding focused lifecycle rerun also passed; it overlaps the full suite and is not an additional unique scenario. Both original-page and fresh-context canvas/buffer and actual camera-movement assertions passed. Tests used isolated synthetic libraries and software WebGL. Camera movement means an initial change, not completion of the overview animation. Unchanged production sources retain the 761-test unit and four orderly idle-service restart results; current lint/i18n and public build passed. The final evidence manifest records privacy and document-rendering checks separately. This verification preceded the local commit; it does not establish remote CI, push or release status.

Earlier full runs and a focused run failed with navigation/rendering errors; one outer process exhausted system commit memory. Their logs and snapshots remain preserved. Resources were improved before this rerun, but the historical fragment-shader/zero-buffer root cause remains unconfirmed. No product rendering fix is claimed.

Read-only lifecycle observations are best effort: this full run retained 8 samples with 2 two-second sampling timeouts. Missing samples are not healthy evidence. Observed camera-check states had nonzero buffers and no lost context or error panel; the full-run log and saved graphics diagnostics recorded no rendering errors. Observation caps and acceptance assertions/deadlines remain. Diagnostics never cancel context events or force recovery. Timed-out evaluations are not cancelled; context disposal owns outstanding work. Extremely late samples or worker/save failures may prevent complete attachments. Real GPU/device, private-library and user visual acceptance remain open.
