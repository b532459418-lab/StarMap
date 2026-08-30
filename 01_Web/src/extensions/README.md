# StarMap 本地扩展

本目录是相对上游 StarMap 的薄包装层，用来接入 Google 图源和城市 Photorealistic 3D，尽量少改官方文件。

## 凭据

在被 Git 忽略的 `01_Web/.env.local` 中自行填写（不要把完整 Key 提交或粘贴到对话里）：

```text
VITE_GOOGLE_MAPS_TILES_KEY=
```

需要启用 Google Cloud 的 [Map Tiles API](https://developers.google.com/maps/documentation/tile/2d-tiles-overview)，并开通计费。同一把 Key 同时用于：

- 图源菜单中的「谷歌」2D 卫星影像
- 底部 dock 的「城市 3D」开关（Photorealistic 3D Tiles）

未填写时，「谷歌」行显示红灯且不可选，城市 3D 按钮不出现；Cesium / 天地图 / 本地低清行为与官方版一致。修改 `.env.local` 后必须重启开发服务器。

可选：把 `VITE_MAP_SOURCE=google` 写在 `.env.local` 里作为初始图源（仅当 Key 已填写时生效）。浏览器会记住上次选中的可用图源。

## 上游挂钩

下列官方文件只改了 import 路径和最小 props，便于以后 `git merge upstream`：

- `src/App.tsx`
- `src/components/CesiumAtlasGlobe.tsx`
- `src/components/MapSourceSwitcher.tsx`
