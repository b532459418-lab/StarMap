/**
 * Want to Go 应用数据层（PRD FR-WTG-2 / FR-PUB-1）。
 *
 * 这里【不是】 StarMap Core：它经 ./appStore.ts 依赖 Vite 虚拟模块与 import.meta.env，
 * 只能在 Vite 里跑。3C-5B 起数据是读模型经官方视图（./store/projectCanonical.ts）得到的 Canonical，投影的纯逻辑在
 * src/worldgraph/adapters/wantToGo.ts；
 * 应用侧派生（隐藏条目、按记录 id 反查条目的两张表、「想去 → 足迹」的禁用原因）
 * 经 Canonical 计算（./canonical/derive.ts；PR1 的旧派生 deriveWantToGo 在 PR5b 删除）。
 * 3C-5 D 起经 hook 取用（见下）。坏数据在迁移时就被拒绝（迁移不接受 readV2 会跳过的记录），读模型里没有。
 *
 * 数据来源规则（FR-PUB-1）在 ./rawInputs.ts，按顺序判定：
 *
 * 1. 强制样例模式（VITE_TRAVEL_ATLAS_DATA_MODE=sample，或开发时 ?data=sample）或公开模式
 *    → tracked 的中性样例（3C-5B 起是原生样例的读模型 src/data/sample/sample.read-model.json，经官方视图）。
 *    判定与足迹完全一致。公开模式下虚拟模块本来就不注入任何私有数据。
 * 2. 否则个人模式（import.meta.env.MODE === 'personal'）→ 私人数据的读模型（新库；还没迁移时是 data/v2/ 在内存里迁移的
 *    读模型，RFC-LOC-1 PR5a 起旧格式的 want-to-go.local.json 不再读取）；没有数据 → 空列表，【不】回落样例。
 *    理由：样例条目若出现在个人模式，会带着「隐藏」按钮，而隐藏请求写的是私有文件，必然报"找不到这条想去记录"。
 *    足迹同样不回落样例（决定 E）。
 *
 * 写入控件只对 'local' 来源开放（WantToGoCard 的「隐藏」、LayerPanel 的添加入口），
 * 这是 localEditorAvailable 之外的另一层门控。
 */

import { useAppSection } from './appStore.ts'

// 3C-5 D: the data are no module constants any more: components read them through the hook below (./appStore.ts), so a
// save moves them on without a reload and react-hooks/exhaustive-deps sees every dependency on them. 

/**
 * 想去的全部派生：wantToGoDataSource（'local' | 'sample' | 'none'）、wantToGoItems、wantToGoProblems、hiddenWantToGoItems、
 * wantToGoItemById、plannedRecordById，以及「想去 → 足迹」（PR9）的前置条件 wantToGoConvertBlockReason、
 * plannedConvertBlockReason（返回 undefined 表示可以转换；规则与写入端点共用 ./canonical/convertRules.ts，审查 C2）。
 */
export const useWantToGo = () => useAppSection('wantToGo')
