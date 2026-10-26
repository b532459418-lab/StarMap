/**
 * 本地编辑器插件里与私人数据有关的两件事，抽成纯函数以便单测（RFC-LOC-1 PR3b-1 规格 §2.2、§2.3；PR5a 规格 §4.1；3C-3）：
 *
 * 1. 虚拟模块 `virtual:starmap-private-data` 的内容（六个导出）：
 *    - `privateReadModelUrl`（3C-5B）：个人模式下读模型 `starmap.read-model`（src/worldgraph/readModel/types.ts）的地址，
 *      相对于站点根（BASE_URL）；App 启动时取回它（src/data/rawInputs.ts），读模型从不内联在模块里。公开模式为 undefined。
 *      - 开发服务器：只读端点 `__travelatlas/editor/read-model?revision=N`（新库，./store-session.mjs 的读模型），或
 *        `…?v2=<V2 文件的摘要>`（不是新库：`data/v2/` 的五个文件在内存里迁移一次，./compat/store-migrate.mjs 的
 *        migrationReadModel，什么都不写；没有文件时是空文件迁移出的读模型）。地址随修订号变，保存后的整页刷新不会读到旧数据。
 *      - 个人构建（`vite build --mode personal`）：过滤后的数据文件 `data/read-model.<sha256 前缀>.json`。
 *      App 只有一条读取路径：读模型 → 官方视图 → 派生；从不读旧格式的文件。
 *    - `privateLegacyUnmigrated`：个人模式下私人目录有没迁移的旧数据（判定见 ./legacy-data.mjs）；公开模式恒为 false。
 *      为 true 时 App 显示迁移提示（src/data/privateDataNotice.ts）。新库模式下恒为 false。
 *    - `privateStoreRevision`（3C-3）：新库模式下是全库修订号（写入时作为 `x-starmap-base-revision`）；
 *      V2 模式与公开模式为 undefined。
 *    - `privateStoreReadOnly`（3C-4b）：新库模式下新库没有通过打开检查（可能已损坏）、只能读取时为 true，页面显示只读提示
 *      （src/data/privateDataNotice.ts）；其余情况恒为 false。
 *    - `privateStoreMigrationRequired`（3C-4d）：私人根有 V2 数据、还没有新库（./private-data-source.mjs 的
 *      'migration-required'，原因 v2）时为 true：数据只读显示，页面提示运行 `npm run store:migrate -- --apply`。
 *    - `privateStoreRecoveryRequired`（3C-4d）：没有新库、`data/store/` 下有残留（'needs-recovery'），或空的私人根没能建立
 *      新库时为 true：页面提示运行 `npm run library:recover`。
 * 2. 私人数据目录的文件变化要不要处理（让虚拟模块失效、按原有条件整页刷新）：`data/v2/` 之内的新建、修改、删除，
 *    以及四个旧数据文件的新建与删除（它们的有无决定「未迁移」），以及新库文件 `data/store/world.sqlite` 的新建与删除
 *    （它的有无决定数据模式；它的修改是新库自己的提交，不处理）。这样迁移工具写出 V2 文件或新库、导入器更新媒体目录、
 *    用户把旧文件移走，不重启服务也能生效。
 *
 * 这里只有纯函数；读文件、判定「未迁移」在插件里做。
 * 本文件不 import 插件（插件在模块顶层解析私有资料层路径，并 import 了 sharp / undici / world-countries）。
 * 取代了 PR3b-1 起的 local-editor-data-mode.mjs（数据模式已删除）。
 */

import path from 'node:path'

import { legacyDataPaths } from './legacy-data.mjs'
import { mayBeInside } from './path-containment.mjs'
import { storeFileOf } from './private-data-source.mjs'

/** 虚拟模块的导出名（顺序即源码里的顺序）。 */
export const PRIVATE_DATA_MODULE_EXPORTS = Object.freeze(['privateReadModelUrl', 'privateLegacyUnmigrated', 'privateStoreRevision', 'privateStoreReadOnly', 'privateStoreMigrationRequired', 'privateStoreRecoveryRequired'])

/**
 * 虚拟模块的全部导出。`readModelUrl` 是读模型的地址（插件在个人模式下总会给出；缺了 App 就显示错误页），
 * `legacyUnmigrated` 是 ./legacy-data.mjs 的判定，`storeRevision` 是新库模式的全库修订号（不是新库时不传），
 * `storeReadOnly` 是新库模式下「库损坏、只读」的判定（./store-session.mjs），`storeMigrationRequired` 与
 * `storeRecoveryRequired` 是不是新库时的状态（3C-4d）。公开模式忽略它们。
 */
export function privateDataModuleExports({ profile, readModelUrl, legacyUnmigrated = false, storeRevision, storeReadOnly = false, storeMigrationRequired = false, storeRecoveryRequired = false }) {
  const personal = profile === 'personal'
  return {
    privateReadModelUrl: personal && typeof readModelUrl === 'string' && readModelUrl !== '' ? readModelUrl : undefined,
    privateLegacyUnmigrated: personal && legacyUnmigrated === true,
    privateStoreRevision: personal && Number.isSafeInteger(storeRevision) && storeRevision >= 0 ? storeRevision : undefined,
    privateStoreReadOnly: personal && storeReadOnly === true,
    privateStoreMigrationRequired: personal && storeMigrationRequired === true,
    privateStoreRecoveryRequired: personal && storeRecoveryRequired === true,
  }
}

/** 导出 → 模块源码。值为 undefined 的导出写成 `undefined`，对象里值为 undefined 的键省略（JSON）。 */
export function renderPrivateDataModule(exports) {
  return Object.entries(exports)
    .map(([name, value]) => `export const ${name} = ${JSON.stringify(value)};`)
    .join('\n')
}

/** 插件监听的文件事件：新建、修改、删除（chokidar 的事件名）。目录事件不单独处理，目录里的文件各自有事件。 */
export const PRIVATE_DATA_WATCH_EVENTS = Object.freeze(['add', 'change', 'unlink'])

/**
 * 私人数据目录里这个文件事件要不要处理（`privatePaths` 是 `getPrivatePaths()` 的结果）：
 * - `data/v2/` 之内（含它本身）的新建、修改、删除：V2 数据变了；
 * - 四个旧数据文件的新建与删除：「未迁移」的判定可能变了。旧文件的内容 App 不读，修改不用处理。
 * - 新库文件 `data/store/world.sqlite` 的新建与删除（3C-3）：数据模式变了。它的修改（新库自己的提交）与日志文件不处理。
 * 其余（迁移清单、PR4 的数据模式标记、旧格式的 `.bak`、`data/` 之外）都不处理。
 */
export function shouldHandlePrivateDataChange(event, changedPath, privatePaths) {
  if (!PRIVATE_DATA_WATCH_EVENTS.includes(event)) return false
  // 含 data/v2 本身；只按路径层级判断（./path-containment.mjs 的 mayBeInside：漏掉事件比多刷新一次更糟，所以 `..x` 这类名字
  // 也算在里面），只是前缀相同的兄弟目录不算。删除事件的文件已不在，不读磁盘。
  if (mayBeInside(privatePaths.v2DataRoot, changedPath, { allowRoot: true })) return true
  if (event === 'change') return false
  const same = (target) => path.relative(path.resolve(target), path.resolve(changedPath)) === ''
  return same(storeFileOf(privatePaths)) || legacyDataPaths(privatePaths).some(same)
}

/**
 * 3C-5 D: a change of the library's files (`data/store/world.sqlite` or its write-ahead log `-wal`): a commit, perhaps by
 * another process (a command-line import). The plugin then asks the store session to look for it (checkExternal); its
 * own commits are no change there (the cache already holds them).
 */
export function isStoreFileChange(event, changedPath, privatePaths) {
  if (event !== 'change' && event !== 'add') return false
  const store = path.resolve(storeFileOf(privatePaths))
  const changed = path.resolve(changedPath)
  return changed === store || changed === `${store}-wal`
}
