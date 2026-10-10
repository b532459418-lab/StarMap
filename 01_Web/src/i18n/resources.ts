import { appShellResources } from './appShellResources.ts'
import { layerResources } from './layerResources.ts'
import { auxiliaryResources } from './auxiliaryResources.ts'
import { domainErrorResources } from './domainErrorResources.ts'
import { mapMenuResources } from './mapMenuResources.ts'
import { droneEditorResources } from './droneEditorResources.ts'
import { mediaViewerResources } from './mediaViewerResources.ts'
import { mediaImportResources } from './mediaImportResources.ts'
import { mediaRecoveryResources } from './mediaRecoveryResources.ts'
import { editorResources } from './editorResources.ts'
import { detailsResources } from './detailsResources.ts'
import { journeyResources } from './journeyResources.ts'
import { timeFilterResources } from './timeFilterResources.ts'
import { DEFAULT_UI_LOCALE, EN_UI_LOCALE } from '../data/uiLocale.ts'

export const resources = {
  [DEFAULT_UI_LOCALE]: {
    timeFilter: { ...timeFilterResources.zh, noMapResults: '当前范围没有可绘制地点。无坐标记录仍可在旅程与收藏查看。', dateQuality: '全部可浏览足迹资料需核对日期：部分 {{partial}} 条、缺失 {{missing}} 条、无效 {{invalid}} 条。' },
    layer: layerResources.zh,
    auxiliary: auxiliaryResources.zh,
    appShell: appShellResources.zh,
    domainError: domainErrorResources.zh,
    mapMenu: mapMenuResources.zh,
    droneEditor: droneEditorResources.zh,
    mediaViewer: mediaViewerResources.zh,
    mediaImport: mediaImportResources.zh,
    mediaRecovery: mediaRecoveryResources.zh,
    editor: editorResources.zh, details: detailsResources.zh, journey: journeyResources.zh,
    common: {
      language: '界面语言', subtitle: '记录你走过的地方，让每段旅程成为可以重温的故事。',
      navigation: '主导航', map: '地图', journey: '旅程', collection: '收藏',
      repositoryReadonlyPreview: '合成库只读预览，编辑未启用。',
      visitRecords_other: '{{count}} 条旅行记录', wantToGo: '想去',
    },
    collection: {
      title: '收藏', heading: '想去的地方', description: '想去图层里的全部地点，包括地图上暂时看不到的。',
      total: '全部', onMap: '可映射条目', hidden: '已隐藏', noLocation: '无坐标', fromTravelLog: '来自旅行记录',
      allDataHint: '全部资料，不受地图时间筛选影响。',
      all: '全部', visible: '显示中', recent: '最近加入', name: '名称', country: '国家',
      places_other: '{{count}} 个地点', filteredPlaces_other: '{{visible}} / {{count}} 个地点',
      add: '添加想去的地方', search: '搜索想去的地方', searchPlaceholder: '搜索名称、国家代码或备注',
      status: '按状态筛选', sort: '排序', empty: '暂时没有想去的地方。', emptyEditable: '还没有想去的地方。',
      noResults: '没有符合条件的地点。', clear: '清除筛选', added: '{{date}} 加入',
      wholeCountry: '整个国家', readOnlyTravel: '来自旅行记录 · 只读', sample: '样例',
      tags: '{{name}}的标签', note: '{{name}}的备注', notePlaceholder: '为什么想去？',
      cancel: '取消', save: '保存', saving: '正在保存…', view: '在地图上查看', visited: '标记为去过',
      editNote: '编辑备注', restore: '恢复', delete: '彻底删除', hide: '隐藏',
      cancelNoteFor: '取消编辑备注：{{name}}', saveNoteFor: '保存备注：{{name}}', viewFor: '在地图上查看：{{name}}',
      visitedFor: '标记为去过：{{name}}', editNoteFor: '编辑备注：{{name}}', restoreFor: '恢复：{{name}}',
      deleteFor: '彻底删除：{{name}}', hideFor: '隐藏：{{name}}',
      deleteConfirm: '确定彻底删除「{{name}}」吗？此操作无法撤销。',
      saveFailed: '保存备注失败。', hideFailed: '隐藏失败。', restoreFailed: '恢复失败。', deleteFailed: '彻底删除失败。',
    },
  },
  [EN_UI_LOCALE]: {
    timeFilter: { ...timeFilterResources.en, noMapResults: 'No mappable places in the current range. Records without coordinates remain available in Journey and Collection.', dateQuality: 'All browsable footprint data: {{partial}} partial, {{missing}} missing and {{invalid}} invalid dates to review.' },
    layer: layerResources.en,
    auxiliary: auxiliaryResources.en,
    appShell: appShellResources.en,
    domainError: domainErrorResources.en,
    mapMenu: mapMenuResources.en,
    droneEditor: droneEditorResources.en,
    mediaViewer: mediaViewerResources.en,
    mediaImport: mediaImportResources.en,
    mediaRecovery: mediaRecoveryResources.en,
    editor: editorResources.en, details: detailsResources.en, journey: journeyResources.en,
    common: {
      language: 'Interface language', subtitle: 'Map the places you have visited and turn every journey into a story you can revisit.',
      navigation: 'Primary navigation', map: 'Map', journey: 'Journey', collection: 'Collection',
      repositoryReadonlyPreview: 'Read-only synthetic repository preview. Editing is disabled.',
      visitRecords_one: '{{count}} visit record', visitRecords_other: '{{count}} visit records', wantToGo: 'Want to go',
    },
    collection: {
      title: 'Collection', heading: 'Places you want to go', description: 'Every place in your Want to Go layer, including places currently absent from the map.',
      total: 'Total', onMap: 'Mappable entries', hidden: 'Hidden', noLocation: 'No location', fromTravelLog: 'From travel log',
      allDataHint: 'All records, unaffected by map time filters.',
      all: 'All', visible: 'Visible', recent: 'Recently added', name: 'Name', country: 'Country',
      places_one: '{{count}} place', places_other: '{{count}} places',
      filteredPlaces_one: '{{visible}} / {{count}} place', filteredPlaces_other: '{{visible}} / {{count}} places',
      add: 'Add a place to visit', search: 'Search places to visit', searchPlaceholder: 'Search names, country codes or notes',
      status: 'Filter by status', sort: 'Sort', empty: 'No places to visit yet.', emptyEditable: 'You have not added any places to visit yet.',
      noResults: 'No matching places.', clear: 'Clear filters', added: 'Added {{date}}',
      wholeCountry: 'Whole country', readOnlyTravel: 'From travel log · Read only', sample: 'Sample',
      tags: 'Tags for {{name}}', note: 'Note for {{name}}', notePlaceholder: 'Why do you want to visit?',
      cancel: 'Cancel', save: 'Save', saving: 'Saving…', view: 'View on map', visited: 'Mark as visited',
      editNote: 'Edit note', restore: 'Restore', delete: 'Delete permanently', hide: 'Hide',
      cancelNoteFor: 'Cancel editing note for {{name}}', saveNoteFor: 'Save note for {{name}}', viewFor: 'View on map: {{name}}',
      visitedFor: 'Mark as visited: {{name}}', editNoteFor: 'Edit note for {{name}}', restoreFor: 'Restore: {{name}}',
      deleteFor: 'Delete permanently: {{name}}', hideFor: 'Hide: {{name}}',
      deleteConfirm: 'Permanently delete “{{name}}”? This cannot be undone.',
      saveFailed: 'Could not save the note.', hideFailed: 'Could not hide this place.', restoreFailed: 'Could not restore this place.', deleteFailed: 'Could not delete this place.',
    },
  },
}
