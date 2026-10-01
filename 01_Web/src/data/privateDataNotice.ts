/**
 * 个人模式地图页上方的私人数据提示（RFC-LOC-1 PR3b-1 规格 §2.4，决定 E；PR3b-2 规格 §2.7 定空状态文案；
 * PR5a 规格决定 I、§4.1 加迁移提示）——显示什么，由这个纯函数决定；组件在 `../components/PrivateDataNotice.tsx`。
 *
 * - 只在个人模式下才可能显示；公开模式（以及读公开样例的强制样例）什么都不显示。
 * - 私人目录有没迁移的旧数据（判定在 scripts/legacy-data.mjs，经虚拟模块注入）时，显示迁移提示：旧数据还没有迁移，
 *   怎么迁移，不需要旧数据时怎么办。它优先于下面的空状态（未迁移时 data/v2/ 没有文件，地图一定是空的）。
 *   只是说明，不渲染可操作的按钮。
 * - 否则没有任何足迹记录（visited 与 planned），也没有想去条目（含隐藏的）时，显示决定 E 的空状态
 *   「还没有足迹，从添加第一个城市开始。」；有数据时什么都不显示。
 *
 * 约束：Node 24 能直接加载——erasable-only TypeScript，相对 import 带 `.ts`，类型用 `import type`。
 */

export const V2_EMPTY_NOTICE = '还没有足迹，从添加第一个城市开始。'

/**
 * 迁移提示，一行一段，保持简短：完整步骤只写在 README（RFC-LOC-1 PR5b 删除迁移工具后，迁移要用提交 4fd32a9）。
 * 提交号、README 小节与文件名同本地编辑器拒绝写入时的说明（scripts/legacy-data.mjs）。
 */
export const LEGACY_UNMIGRATED_NOTICE: readonly string[] = Object.freeze([
  '私人目录里有旧格式的数据，还没有迁移。迁移之前地图是空的，编辑也不会保存。',
  '迁移：这个版本不再带迁移工具，请先检出 StarMap 的提交 4fd32a9（最后一个带迁移工具的版本）完成迁移，再回到最新版本，步骤见 README 的 Private Data Format 一节。',
  '不需要这些旧数据的话，把私人目录 data/ 下的四个旧文件（travel-map、want-to-go、editor-state、user-media 的 .local.json）移到别处，然后刷新页面。',
])

export interface PrivateDataNoticeInput {
  /** 个人模式（`import.meta.env.MODE === 'personal'`）。 */
  personal: boolean
  /** 私人目录有没迁移的旧数据（`../data/rawInputs.ts` 的 `legacyUnmigrated`；读公开样例时恒为 false）。 */
  legacyUnmigrated: boolean
  /** 足迹记录总数：visited（含不上首页、被 editor 隐藏的）+ planned。 */
  travelRecordCount: number
  /** 想去条目总数（含隐藏的）。 */
  wantToGoItemCount: number
}

export interface PrivateDataNoticeContent {
  kind: 'legacy-unmigrated' | 'empty'
  /** 要显示的段落，按顺序。 */
  lines: readonly string[]
}

/** 要显示的内容；不显示时为 undefined。 */
export const privateDataNotice = (input: PrivateDataNoticeInput): PrivateDataNoticeContent | undefined => {
  if (!input.personal) return undefined
  if (input.legacyUnmigrated) return { kind: 'legacy-unmigrated', lines: LEGACY_UNMIGRATED_NOTICE }
  if (input.travelRecordCount > 0 || input.wantToGoItemCount > 0) return undefined
  return { kind: 'empty', lines: [V2_EMPTY_NOTICE] }
}
