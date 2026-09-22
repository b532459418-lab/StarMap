# Third-party notices

StarMap depends on the software, data, and services listed below. This file is
a summary for orientation. The authoritative license text for each npm package
ships inside that package under `01_Web/node_modules/<name>/`. Verify licenses
and provider terms again before any public deployment; do not rely on this
summary alone.

## Runtime dependencies (`01_Web/package.json`)

| Package | License | Notes |
| --- | --- | --- |
| [Cesium](https://cesium.com/cesiumjs/) | Apache-2.0 | 3D globe engine. Bundles Natural Earth II imagery and the moon texture used by StarMap. Cesium's own `LICENSE.md` lists further third-party components. |
| [Resium](https://github.com/reearth/resium) | MIT | React bindings for Cesium |
| [React](https://react.dev/), react-dom | MIT | |
| [three](https://threejs.org/) | MIT | Used by the frozen legacy globe |
| [react-globe.gl](https://github.com/vasturiano/react-globe.gl) | MIT | Frozen legacy globe implementation |
| [Photo Sphere Viewer](https://photo-sphere-viewer.js.org/) (`@photo-sphere-viewer/core`) | MIT | 360° panorama viewer |
| [exifr](https://mutiny.cz/exifr/) | MIT | EXIF / XMP metadata extraction |
| [lucide-react](https://lucide.dev/) | ISC | Icons |
| [react-markdown](https://github.com/remarkjs/react-markdown), remark-gfm | MIT | Release-note rendering |
| [Tailwind CSS](https://tailwindcss.com/), `@tailwindcss/vite` | MIT | |
| [undici](https://undici.nodejs.org/) | MIT | |
| [world-countries](https://mledoze.github.io/countries/) | ODbL-1.0 | Country dataset. The Open Database License requires attribution and share-alike for the **database**; StarMap uses it unmodified. |

## Development dependencies

| Package | License |
| --- | --- |
| [Vite](https://vite.dev/), `@vitejs/plugin-react`, vite-plugin-cesium | MIT |
| [TypeScript](https://www.typescriptlang.org/) | Apache-2.0 |
| [ESLint](https://eslint.org/), typescript-eslint, eslint-plugin-react-hooks, eslint-plugin-react-refresh, `@eslint/js`, globals | MIT |
| [sharp](https://sharp.pixelplumbing.com/) | Apache-2.0 |
| `@types/*` | MIT |

## Bundled data and textures

| Asset | Source | Terms |
| --- | --- | --- |
| Natural Earth II low-resolution imagery | Shipped inside Cesium (`Assets/Textures/NaturalEarthII`) | Natural Earth data is public domain |
| Moon texture | Shipped inside Cesium (`Assets/Textures/moonSmall.jpg`) | See Cesium's `LICENSE.md` |
| Tracked sample travel data | This repository | MIT, neutral placeholder content |

## Online services (user-supplied credentials)

StarMap never ships provider credentials. Each person who deploys StarMap
accepts the relevant provider terms themselves.

| Service | Used for | Terms |
| --- | --- | --- |
| [Cesium ion](https://cesium.com/platform/cesium-ion/) | Global imagery, terrain, geocoding | [Cesium ion terms of service](https://cesium.com/legal/terms-of-service/) |
| [Tianditu](https://lbs.tianditu.gov.cn/) | Imagery and Chinese labels | Tianditu developer terms |
| [Google Map Tiles API](https://developers.google.com/maps/documentation/tile) | Optional 2D imagery, road labels, Photorealistic 3D Tiles | [Google Maps Platform terms](https://cloud.google.com/maps-platform/terms) and attribution requirements |
| [OpenStreetMap Nominatim](https://nominatim.org/) | Fallback city lookup | Data © OpenStreetMap contributors, ODbL-1.0; usage policy applies |
| [GitHub REST API](https://docs.github.com/rest) | Release update check | GitHub terms |

## Upstream project

This repository is derived from [Aisland-SJL/StarMap](https://github.com/Aisland-SJL/StarMap)
under the MIT License. See [NOTICE.md](NOTICE.md).
