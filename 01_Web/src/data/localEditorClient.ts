import type * as LocalEditorApiModule from './localEditorApi.ts'
import { localEditorAvailable } from './editorState'
import { createMediaJobs, type MediaJobsApi } from './mediaJobs.ts'
import { LocalEditorError } from '../i18n/editorErrors.ts'

/**
 * 本地编辑器在浏览器一侧的唯一入口（第 5B 批）。组件与媒体任务都从这里调用编辑 API，不再静态导入 ./localEditorApi.ts。
 *
 * - ./localEditorApi.ts（全部 `/__travelatlas/editor/*` 请求都在那里）只经下面这一处 `import()` 加载，条件是
 *   `import.meta.env.DEV && localEditorAvailable`。前半句不能省：构建时它在模块转换阶段就被替换成字面量 false，Rolldown
 *   不把这个 `import()` 计入 chunk 图，不生成编辑 API 的 chunk，任何构建产物里都没有这些请求路径。只写
 *   `localEditorAvailable`（从另一个模块导入）时，Rolldown 输出时虽然也把它折叠成 false、删掉调用，但 chunk 在此之前
 *   已经确定，文件照样留在 dist 里（第 5B 批实测，Vite 8.3 / Rolldown 1.2.8）。
 * - 下面的同名函数与原接口签名相同。API 加载之后同步转调（写入照常在调用时就登记到 localEditorCoordination），
 *   加载完成之前先等加载。个人模式下 App 启动时就会读取媒体任务，所以 API 在第一次编辑之前就已加载。
 * - 编辑器不可用时（公开模式、强制样例）调用这些函数只会得到 `E_LOCAL_EDITOR_FAILED`，不发出任何请求；
 *   这些入口本来也只在 `localEditorAvailable` 为真时才渲染。
 *
 * 类型仍从 ./localEditorApi.ts 用 `import type` 取，编译后不留下任何导入。
 */
type LocalEditorApi = typeof LocalEditorApiModule

let loadedApi: LocalEditorApi | undefined
let loadingApi: Promise<LocalEditorApi> | undefined

export const loadLocalEditorApi = (): Promise<LocalEditorApi> => import.meta.env.DEV && localEditorAvailable
  ? (loadingApi ??= import('./localEditorApi.ts').then(
    (api) => (loadedApi = api),
    (error: unknown) => {
      // 加载失败（例如开发服务器重启）不缓存，下一次调用重新加载。
      loadingApi = undefined
      throw error
    },
  ))
  : Promise.reject(new LocalEditorError({ code: 'E_LOCAL_EDITOR_FAILED' }))

const withApi = <T>(call: (api: LocalEditorApi) => Promise<T>): Promise<T> =>
  loadedApi ? call(loadedApi) : loadLocalEditorApi().then(call)

export { reloadAfterLocalSave } from './localEditorCoordination.ts'
export { placeChoiceCandidatesOf } from './placeChoice.ts'
export { journeyChoiceCandidatesOf } from './journeyChoice.ts'

export const searchLocalCountries: LocalEditorApi['searchLocalCountries'] = (...args) =>
  withApi((api) => api.searchLocalCountries(...args))
export const searchLocalCities: LocalEditorApi['searchLocalCities'] = (...args) =>
  withApi((api) => api.searchLocalCities(...args))
export const addLocalCountry: LocalEditorApi['addLocalCountry'] = (...args) =>
  withApi((api) => api.addLocalCountry(...args))
export const updateLocalEditorState: LocalEditorApi['updateLocalEditorState'] = (...args) =>
  withApi((api) => api.updateLocalEditorState(...args))
export const deleteHiddenLocalMedia: LocalEditorApi['deleteHiddenLocalMedia'] = (...args) =>
  withApi((api) => api.deleteHiddenLocalMedia(...args))
export const deleteHiddenLocalCountries: LocalEditorApi['deleteHiddenLocalCountries'] = (...args) =>
  withApi((api) => api.deleteHiddenLocalCountries(...args))
export const addLocalTravelRecord: LocalEditorApi['addLocalTravelRecord'] = (...args) =>
  withApi((api) => api.addLocalTravelRecord(...args))
export const addLocalWantToGo: LocalEditorApi['addLocalWantToGo'] = (...args) =>
  withApi((api) => api.addLocalWantToGo(...args))
export const updateLocalWantToGo: LocalEditorApi['updateLocalWantToGo'] = (...args) =>
  withApi((api) => api.updateLocalWantToGo(...args))
export const deleteHiddenLocalWantToGo: LocalEditorApi['deleteHiddenLocalWantToGo'] = (...args) =>
  withApi((api) => api.deleteHiddenLocalWantToGo(...args))
export const convertLocalWantToGoToTravel: LocalEditorApi['convertLocalWantToGoToTravel'] = (...args) =>
  withApi((api) => api.convertLocalWantToGoToTravel(...args))

const mediaJobsApi: MediaJobsApi = {
  read: () => withApi((api) => api.readMediaJobs()),
  create: (...args) => withApi((api) => api.createMediaJob(...args)),
  receive: (...args) => withApi((api) => api.receiveMediaJobFile(...args)),
  preview: (...args) => withApi((api) => api.previewMediaJob(...args)),
  import: (...args) => withApi((api) => api.importMediaJob(...args)),
  pause: (...args) => withApi((api) => api.pauseMediaJob(...args)),
  close: (...args) => withApi((api) => api.closeMediaJob(...args)),
  abandon: (...args) => withApi((api) => api.abandonMediaJob(...args)),
}

/** 页面上唯一的媒体任务队列（原在 ./mediaJobs.ts，移到这里是为了让它经上面的门调用编辑 API）。 */
export const mediaJobs = createMediaJobs({ api: mediaJobsApi })
