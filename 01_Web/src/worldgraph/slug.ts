/**
 * slug 规则 —— World Graph Core 里唯一的一份。
 *
 * 用在两处：想去条目的 EntityId（`place:wtg:<CC>:<slug(nameEn)>`，adapters/wantToGo.ts）
 * 与图层查询的 FR-MR-5 合并键（`<CC>:<slug(name)>`，query.ts）。两处必须同一规则，
 * 否则「同一个地点」在 id 与合并键上会被判成两个地方。
 *
 * 规则与 scripts/want-to-go-store.mjs 和 scripts/local-editor-plugin.mjs 的 slugify
 * 逐字相同（小写、NFKC、非字母数字折叠成 `-`、去首尾 `-`）。脚本层是 .mjs，
 * 不能 import TS，所以它们各自保留副本；改动任何一处都必须三处同时改。
 *
 * 约束同其它 Core 文件：纯函数、erasable-only TypeScript、不依赖运行环境。
 */

export const slugify = (value: string): string => value
  .toLowerCase()
  .normalize('NFKC')
  .trim()
  .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
  .replace(/^-|-$/g, '')
