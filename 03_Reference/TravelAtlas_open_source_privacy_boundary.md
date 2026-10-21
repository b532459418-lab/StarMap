# StarMap 开源模板与个人数据边界

## 目标

StarMap 是一个产品、一套代码和一套数据模型，不维护两份代码。它支持两个显式运行配置：

1. **个人编辑配置**：`npm run dev:personal` 从外置私有层加载配置、旅行记录与媒体，并启动仅限本机的写入中间件。
2. **公共展示配置**：`npm run dev:public` 或 `npm run build:public` 只加载 Git 跟踪的中性示例，不渲染编辑按钮，也不存在本地写入接口。

每个下载开源项目的用户都拥有本地编辑能力；只有部署产物是只读展示。编辑能力不是原作者专属，也不依赖聊天框、DeepSeek Harness 或在线 AI。

本地编辑中的国家候选来自随开发依赖安装的结构化国家目录；城市候选由用户明确点击检索后，通过国家代码约束的 OpenStreetMap Nominatim 联网查询获得，不做逐键自动补全。它不需要 API Key，不把完整世界城市库打进前端，也不会把查询结果写入 Git；只有用户明确选中并确认的国家或城市才进入被忽略的本地数据。日期仍由用户明确填写。

正式维护工作区的私有层是与源码仓库并列的 `StarMap/06_private/`；独立下载用户可通过 `STARMAP_PRIVATE_ROOT` 指向任意私有目录，或使用源码根内被忽略的 `06_private/` 兜底目录。`.gitignore` 是第二道保险，主要边界是个人内容在物理上不属于源码 Git 仓库。

## 运行时优先级

```text
dev:personal / build:personal
        ↓
加载 <private-root>/config/.env.local，
以及私有层的旅行记录、想去、编辑状态与媒体文件
（data/v2/ 下的五个 V2 文件，另有 media/user/；data/ 下旧格式的 travel-map / want-to-go /
 editor-state / user-media 四个 .local.json 不再读取，只供迁移工具使用）

dev:public / build:public
        ↓
只加载 Git 跟踪的中性示例
（3C-5B 起是原生样例 src/data/sample/ 的读模型；src/data/v2-sample/ 的五个 V2 文件只留作迁移与兼容测试的输入）
```

个人配置只读写 `data/v2/`。私人目录里有还没迁移的旧格式文件（且 `data/v2/` 里没有 V2 文件）时，页面显示迁移提示，本地编辑器与媒体导入拒绝写入；当前版本不再带迁移工具，迁移要先检出提交 `4fd32a9`，迁移后回到最新版本；迁移之后，旧格式文件与早期版本的 `data/data-mode.local.json` 标记都不再读取。详见 [Web 工作区说明](../01_Web/README.md#private-data-format)。

`build:personal` 只带页面显示得到的内容：被隐藏的国家、城市、想去条目、照片和航拍，连同只能经由它们到达的记录、媒体与地点，都不进入构建的数据；构建目录里也只复制保留下来的媒体条目引用到的原图与缩略图（`01_Web/src/data/store/personalBuildReadModel.ts`，3C-5B 起在新库的读模型上过滤）。个人构建的数据不在 JS 包里，而是构建目录里单独的 `data/read-model.<hash>.json`，页面启动时加载。`dev:personal` 照旧提供全部数据，供编辑器恢复或彻底删除隐藏的条目。

公共模式从不自动发现个人数据，即使私有层存在也不会读取。`npm run release:check` 还会只归档 Git 已跟踪文件，在系统临时目录中重新安装、Lint、运行测试和公共构建，确保检查过程看不到私有层。

## 边界表

| 内容 | 私人开发仓库 | 干净公开仓库 | 说明 |
| --- | --- | --- | --- |
| React / Cesium / UI 源码 | 保留 | 保留 | 产品主体 |
| `src/data/sample/` | 保留 | 保留 | 公开模式读取的中性示例（3C-5B 起）：源文件与生成的读模型，`privacy:check` 检查 |
| `src/data/v2-sample/` | 保留 | 保留 | 同一个样例的五个 V2 文件，手工维护，只作迁移与兼容测试的输入，`privacy:check` 检查 |
| `<private-root>/data/v2/` | 外置私有层 | 不包含 | 个人数据（App 只读写这里）：`places` / `travel-map` / `want-to-go` / `editor-state` / `user-media` 五个 `.local.json`，以及 `media-source-index.local.json` |
| `<private-root>/data/migration/` | 外置私有层 | 不包含 | 旧数据迁移到 V2 时（提交 `4fd32a9` 的迁移工具）的迁移清单与决定文件 |
| `<private-root>/data/data-mode.local.json` | 外置私有层 | 不包含 | 早期版本写下的数据模式标记，现已不再读取、不再写入，删留随意 |
| `<private-root>/data/travel-map.local.json` | 外置私有层 | 不包含 | 旧格式（App 不再读取，只供迁移）：个人国家、城市、路线和显示规则 |
| `<private-root>/data/want-to-go.local.json` | 外置私有层 | 不包含 | 旧格式（App 不再读取，只供迁移）：个人想去的城市、国家与备注 |
| `<private-root>/data/editor-state.local.json` | 外置私有层 | 不包含 | 旧格式（App 不再读取，只供迁移）：排序、隐藏、封面和媒体布局等本地编辑状态 |
| `<private-root>/MediaInbox/<真实国家>/` | 外置私有层 | 不包含 | 原始媒体与私有旁车 |
| `<private-root>/media/user/` | 外置私有层 | 不包含 | 网页使用的个人媒体副本 |
| `<private-root>/data/user-media.local.json` | 外置私有层 | 不包含 | 旧格式（App 不再读取，只供迁移）：个人媒体目录与无人机坐标 |
| `<private-root>/config/.env.local` | 外置私有层 | 不包含 | Token 与本地模式 |
| Inbox 模板、Schema、导入脚本 | 保留 | 保留 | 供其他用户和 Agent 使用 |
| 示例图片 | 可选 | 只包含明确授权或生成的样图 | 不得用个人照片占位 |

## 个人网站不受影响的原因

个人旅行记录、原图、网站衍生物、目录与环境配置全部进入外置私有层。`dev:personal` 显式注入这些文件，因此国家列表、城市、相机初始位置和 Drone Media 交互保持个人状态；`dev:public` 则明确忽略它们。

公开用户克隆仓库后默认显示 North Atlantic 中性示例。个人配置下，全新的私人目录使用 V2 数据格式，从空地图开始：用本地编辑器添加国家与城市，再按[媒体导入协议](TravelAtlas_media_import_protocol.md)投放照片；国家和城市列表会从其数据自动生成，不继承原作者列表，也不复制示例。

## GitHub 与网站公开性的区别

GitHub 不包含个人照片和旅行数据。若个人网站本身部署到公网，浏览器必须能够访问页面上显示的照片和国家城市信息，因此这些已展示内容对网站访客可见。可采用两种部署方式：

- 从本机完成包含私有数据的构建后直接部署构建产物，不通过公开 GitHub 构建。
- 把个人媒体放在独立对象存储中，公开仓库只保留应用代码。

本地开发服务中的 `/__travelatlas/editor/*` 与 `/media/user/*` 由 Vite 的 `serve` 阶段临时注册，只在个人配置下存在。浏览器里任何 `localhost`、`127.0.0.1` 页面的请求都来自本机，所以「来自本机」本身不足以区分本应用与本机的其他页面（别的开发服务器、本地工具、其中混入的依赖）。个人配置的开发服务因此按下面的规则处理请求：

- 关闭 Vite 的 CORS（`server.cors: false`）：不向任何其他来源返回 `Access-Control-Allow-Origin`。
- 跨站请求守卫：注册在 Vite 自己的中间件之前，私人数据虚拟模块、`/@fs/`、`/media/user/*` 与编辑接口都在它之后。浏览器标为 `Sec-Fetch-Site: cross-site` 或 `same-site`（例如另一个端口上的 `localhost` 页面）的请求，只要不是打开页面本身（`Sec-Fetch-Mode: navigate`），一律返回 403。别处的链接仍能打开页面，但不能读取、嵌入或导入其中的任何资源。
- 只读接口（`GET /__travelatlas/editor/state`、`/__travelatlas/editor/read-model`（3C-5B：App 启动时从这里取私人数据的读模型）、`/__travelatlas/editor/catalog/*`）与 `/media/user/*`：要求本机 socket；带 Origin 时必须与本服务同源（同协议、同主机、同端口）；`Sec-Fetch-Site` 必须缺省、为 `same-origin` 或 `none`。媒体响应带 `Cross-Origin-Resource-Policy: same-origin` 与 `X-Content-Type-Options: nosniff`。
- 写入接口与媒体任务接口：要求本机 socket；带 Origin 时必须与本服务同源；并且带请求头 `x-travelatlas-local-editor: 1`。自定义请求头会触发跨源预检，而个人配置不放行任何跨源预检。

`vite preview`（`npm run preview`）直接服务 `dist`，而 `dist` 可能是包含私人数据与原图的个人构建，所以预览服务不论哪种模式都关闭 CORS（`preview.cors: false`），并在自己的中间件之前注册同一个跨站请求守卫；同源访问照常可用。

不带 `Sec-Fetch-*` 头的本机工具（curl、脚本、测试）不受守卫影响，仍按各接口自己的检查处理。正式构建不携带这个服务端能力；隐藏编辑按钮本身不作为安全措施，真正的边界是公开部署中没有写入接口。

## 干净公开仓库允许清单

公共 GitHub 只维护源码仓库中的已跟踪文件。允许范围包括：

- 根目录 `README.md`、`README.zh.md`、`LICENSE`、`NOTICE.md`、`THIRD_PARTY_NOTICES.md`、`CONTRIBUTING.md`、`SECURITY.md`、`TRADEMARK.md`、`AGENTS.md`、`.gitignore`、`.gitattributes` 与 `.github/`。
- `docs/`：版本与许可说明（`editions.md`）、发布说明与产品图片。
- `01_Web/` 中的源码、测试、脚本与 `.env.example`，不含任何私有层内容、构建输出和本地缓存。
- `02_Assets/MediaInbox/README.md` 与 `_country-template/`。
- `02_Assets/README.md`、媒体与旅行数据 Schema、导入协议、开源隐私边界、公开安装说明和明确授权的示例资产。

私人备案工作日志、项目级 Handoff、内部设计 QA、MediaLab 索引与本机路径说明不进入公共仓库。它们继续留在本地项目历史中，公共仓库只承载产品、使用说明和陌生用户真正需要的 Agent 规则。

任何私人内容即使通过检查，也不因此获得进入 GitHub 的授权。

## 发布前强制检查

从 `01_Web/` 运行：

```powershell
npm run release:check
```

`release:check` 要求源码工作区干净，检查 Git 跟踪清单与关键 `.gitignore` 防线，并在只含 Git 跟踪文件的系统临时目录中执行 `npm ci`、Lint、`npm test` 与 `build:public`；这些命令只继承净化过的环境变量（不带 `STARMAP_PRIVATE_ROOT`、`VITE_*` 与各类 token），失败时打印已捕获的输出。它不能清洗旧历史，也不替代发布授权。

## 相关文档

- [公共使用说明](../README.zh.md)
- [媒体导入协议](TravelAtlas_media_import_protocol.md)
- [Web 工作区说明](../01_Web/README.md)
