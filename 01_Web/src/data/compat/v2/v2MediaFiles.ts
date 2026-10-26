/**
 * The V2 media files (RFC-LOC-1 PR3b-3 spec §2.3): the media catalog (`data/v2/user-media.local.json`), the media
 * source index (`data/v2/media-source-index.local.json`) and the catalog's integrity check with the other four files.
 * 3C-5 E: moved here from ../../v2media/importPlan.ts.
 *
 * Compat (3C-5 E spec §2.4): V2 files are read and written only to migrate a library, to show a root that awaits
 * migration (read-only), and to export a library to V2 (store:export-v2). Ordinary read and write code does not
 * import this directory (scripts/compat-boundary.test.mjs).
 *
 * Constraint: Node 24 loads it directly (erasable-only TypeScript, relative imports with `.ts`, `import type` for types).
 */
import type { CanonicalMediaItem } from '../../canonical/types.ts'
import { MEDIA_SCHEMA_VERSION } from '../../canonical/schemaVersions.ts'
import type { V2MediaFile } from './v2Schema.ts'
import { completeForWrite, integrityProblems, type V2FilesOrEmpty } from './v2Integrity.ts'

/** 源文件索引：媒体 id → 投递箱里的相对路径（含重复文件，去重、保持先后）。 */
export const sourcesByIdOf = (entries: readonly { id: string; sourcePath: string }[]): Record<string, string[]> => {
  const result: Record<string, string[]> = {}
  for (const entry of entries) result[entry.id] = [...new Set([...(result[entry.id] ?? []), entry.sourcePath])]
  return result
}

/** V2 源文件索引的文件名（`data/v2/` 下）。它不属于 V2 的五个文件，不进 `validateV2Files`（§2.3）。 */
export const V2_MEDIA_SOURCE_INDEX_FILE_NAME = 'media-source-index.local.json'

/** V2 媒体目录（`data/v2/user-media.local.json`）。 */
export const mediaCatalogFileOf = (items: readonly CanonicalMediaItem[], generatedAt: string): V2MediaFile => ({
  schemaVersion: MEDIA_SCHEMA_VERSION,
  generatedAt,
  privacyLevel: 'local-only',
  items: [...items],
})

/** V2 源文件索引（形状同旧模式的索引；id 空间不同，所以分开存）。 */
export const mediaSourceIndexFileOf = (sourcesById: Record<string, string[]>, generatedAt: string) => ({
  schemaVersion: 1,
  generatedAt,
  sourcesById,
})

/**
 * 写目录前的完整性检查（§2.3）：新目录放进五个 V2 文件之后，必须通过 PR3a 的 `validateV2Files` 且没有悬空引用——
 * 其中就包括「每个条目的 placeId 都是注册表里的城市」。返回问题的简述，空数组表示可以写。
 */
export const catalogIntegrityProblems = (files: V2FilesOrEmpty | undefined, catalog: unknown, now: Date): string[] =>
  integrityProblems(completeForWrite({ ...files, media: catalog }, now))
