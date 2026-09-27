declare module 'virtual:starmap-private-data' {
  export const privateEditorState: unknown
  export const privateMediaCatalog: unknown
  export const privateTravelMap: unknown
  export const privateWantToGo: unknown
  /**
   * 私人目录的数据模式（RFC-LOC-1 PR3b-1，判定见 scripts/data-mode.mjs）。公开模式恒为 'legacy'。
   * 为 'v2' 时上面四个旧导出都是 undefined：App 在 V2 模式下绝不会读到旧文件。
   */
  export const privateDataMode: 'legacy' | 'v2'
  /** V2 模式下为 data/v2/ 里的五个 V2 文件（缺的为 undefined）；其他情况为 undefined。 */
  export const privateV2Files:
    | { places?: unknown; travel?: unknown; wantToGo?: unknown; editorState?: unknown; media?: unknown }
    | undefined
}
