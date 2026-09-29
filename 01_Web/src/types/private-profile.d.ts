declare module 'virtual:starmap-private-data' {
  /**
   * 个人模式下为私人目录 data/v2/ 里的五个 V2 文件（缺的为 undefined）；公开模式为 undefined。
   * App 只读这五个文件（RFC-LOC-1 PR5a），旧格式的私人文件不注入。插件：scripts/local-editor-plugin.mjs。
   */
  export const privateV2Files:
    | { places?: unknown; travel?: unknown; wantToGo?: unknown; editorState?: unknown; media?: unknown }
    | undefined
  /**
   * 个人模式下私人目录有没迁移的旧数据（判定见 scripts/legacy-data.mjs：旧数据文件任一存在，且 data/v2/ 没有任何 V2 文件）。
   * 公开模式恒为 false。
   */
  export const privateLegacyUnmigrated: boolean
}
