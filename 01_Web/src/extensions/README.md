# StarMap 本地扩展

本目录是相对上游 StarMap 的薄包装层，用来接入 Google 图源和城市 Photorealistic 3D，尽量少改官方文件。

## 凭据

在 Git 之外的私人资料层中自行填写（不要把完整 Key 提交或粘贴到对话里）：

```text
VITE_GOOGLE_MAPS_TILES_KEY=
```

该文件是 `06_private/config/.env.local`。上游 v0.3.0 把个人配置移出了源码仓库，路径由 `scripts/private-profile.mjs` 解析，顺序为 `$STARMAP_PRIVATE_ROOT` → 源码根目录上一级的 `06_private` → 源码根目录内的 `06_private`。写在 `01_Web/.env.local` 已经不再生效。

需要启用 Google Cloud 的 [Map Tiles API](https://developers.google.com/maps/documentation/tile/2d-tiles-overview)，并开通计费。同一把 Key 同时用于：

- 图源菜单中的「谷歌」2D 卫星影像，以及叠加其上的中文注记与路网
- 底部 dock 的「城市 3D」开关（Photorealistic 3D Tiles）
- 底部 dock 的「地名/路网」开关（Google `layerRoadmap` 与天地图注记叠层；默认开启）

未填写时，「谷歌」行显示红灯且不可选，城市 3D 按钮不出现；Cesium / 天地图 / 本地低清行为与官方版一致。修改后必须重启开发服务器。

必须用 `npm run dev:personal` 启动。`npm run dev` 等价于 `dev:public`，其 Vite 配置为 `envDir: false`，不读取任何 `.env` 文件，Key 不会生效——表现与「没填 Key」完全一致（谷歌红灯、城市 3D 按钮消失），且不报任何错误，很容易误判为功能损坏。

Key 会出现在浏览器的网络请求里，这是 Map Tiles API 的固有特性。公开部署前务必在 Google Cloud 控制台限制 HTTP 来源域名与可用 API。

可选：把 `VITE_MAP_SOURCE=google` 写在同一个文件里作为初始图源（仅当 Key 已填写时生效）。浏览器会记住上次选中的可用图源、地名/路网开关（默认开启）以及城市 3D 的开关状态（默认关闭，避免首次访问就产生 3D 瓦片计费）。地名/路网按钮只在当前图源带注记叠层时出现（谷歌、天地图）。

## 行为说明

- 谷歌影像或注记创建失败时会输出 `console.warn` 并说明排查方向，不再静默降级；该图源会从缓存中移除，下次切换时重试。
- 开启城市 3D 时会隐藏 Cesium 地球底图。Photorealistic 3D Tiles 自带全球地形与地表，隐藏底图可避免地形穿插与闪烁。
- 图源 provider 按图源缓存复用，来回切换不会重复创建 Google session。地名/路网开关只切换 ImageryLayer 的显示，不新建 session。

## 上游挂钩

下列官方文件只改了 import 路径和最小 props，便于以后 `git merge upstream`：

- `src/App.tsx`
- `src/components/CesiumAtlasGlobe.tsx`
- `src/components/MapSourceSwitcher.tsx`
