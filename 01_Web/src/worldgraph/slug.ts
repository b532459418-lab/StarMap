/**
 * slug 规则 —— World Graph Core 里唯一的一份。
 *
 * RFC-LOC-1 Core-A 之前它还用来拼想去条目的 EntityId 与图层查询的同地点合并键；Core-A 起实体 id 是注册表的地点 id、
 * 地图按身份合并，Core 自身不再用它。今天只剩匹配与搜索用途：App 的地点解析（V2 写入「先找后建」）与插件的目录搜索。
 *
 * 规则与 scripts/local-editor-plugin.mjs 的 slugify 逐字相同（小写、NFKC、非字母数字折叠成 `-`、去首尾 `-`）。
 * 那是脚本层仅存的副本（.mjs 的插件模块没有 import 这里）；改动任何一处都必须两处同时改。
 * App 层的 TypeScript（src/data/canonical/placeResolver.ts 等，V2 写入经它判断同一地点）直接 import 本文件。
 * 原来另一份副本在 scripts/want-to-go-store.mjs，那个旧格式的写入模块已在 RFC-LOC-1 PR5a 删除，见 PR5。
 *
 * 约束同其它 Core 文件：纯函数、erasable-only TypeScript、不依赖运行环境。
 */

export const slugify = (value: string): string => value
  .toLowerCase()
  .normalize('NFKC')
  .trim()
  .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
  .replace(/^-|-$/g, '')
