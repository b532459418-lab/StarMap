declare module 'virtual:starmap-private-data' {
  /**
   * 3C-5B：个人模式下为读模型 `starmap.read-model`（src/worldgraph/readModel/types.ts）：新库的读模型；还不是新库时是
   * data/v2/ 的五个 V2 文件在内存里迁移一次得到的读模型。公开模式为 undefined。App 读它之前先过 readReadModel（表头与
   * 行的形状）。旧格式的私人文件不注入。插件：scripts/local-editor-plugin.mjs。
   */
  export const privateReadModel: unknown
  /**
   * 3C-5B：只在个人构建里有值：过滤后的读模型数据文件相对于 BASE_URL 的路径（data/read-model.<sha256 前缀>.json），这时
   * privateReadModel 为 undefined，App 启动时加载这个文件。开发服务器与公开模式为 undefined。
   */
  export const privateReadModelUrl: string | undefined
  /**
   * 个人模式下私人目录有没迁移的旧数据（判定见 scripts/legacy-data.mjs：旧数据文件任一存在，且 data/v2/ 没有任何 V2 文件）。
   * 公开模式恒为 false。
   */
  export const privateLegacyUnmigrated: boolean
  /**
   * 新库模式（3C-3，私人根下有 data/store/world.sqlite）下是全库修订号：页面加载时的读取版本，「修改想去」的请求把它
   * 作为 x-starmap-base-revision 带上。V2 模式与公开模式为 undefined。
   */
  export const privateStoreRevision: number | undefined
  /**
   * 新库模式（3C-4b）下新库没有通过打开检查（可能已损坏）、只能读取时为 true：数据照常显示，写入一律被拒绝
   * （E_STORE_READ_ONLY），页面显示只读提示。其余情况恒为 false。
   */
  export const privateStoreReadOnly: boolean
  /**
   * 3C-4d：私人根有 V2 数据、还没有新库时为 true（scripts/private-data-source.mjs 的 'migration-required'）：数据只读显示，
   * 写入一律被拒绝（E_STORE_MIGRATION_REQUIRED），页面提示运行迁移。其余情况恒为 false。
   */
  export const privateStoreMigrationRequired: boolean
  /**
   * 3C-4d：没有新库、data/store/ 下有残留，或空的私人根没能建立新库时为 true：只读，写入被拒绝（E_STORE_RECOVERY_REQUIRED），
   * 页面提示运行 npm run library:recover。其余情况恒为 false。
   */
  export const privateStoreRecoveryRequired: boolean
}
