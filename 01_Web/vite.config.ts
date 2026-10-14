import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { defineConfig, loadEnv } from 'vite'
import type { Plugin, UserConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Cesium follows Cesium's own Vite setup (github.com/CesiumGS/cesium-vite-example; batch 4B, E8). The `cesium` package is
// bundled like any other dependency, so its code lands in content-hashed chunks; the four directories Cesium loads at run
// time (Workers, ThirdParty, Assets, Widgets) are served and copied unchanged by scripts/cesium-static-plugin.mjs, and
// CESIUM_BASE_URL tells Cesium where they are. They sit under a directory named after the installed Cesium version, so
// their URLs change whenever Cesium does and a host may cache them for good (README: "Caching the public build").
const cesiumPackageJson = createRequire(import.meta.url).resolve('cesium/package.json')
const cesiumVersion: string = JSON.parse(readFileSync(cesiumPackageJson, 'utf8')).version
const cesiumBaseUrl = `cesium/${cesiumVersion}`
const cesiumBuildRoot = path.join(path.dirname(cesiumPackageJson), 'Build', 'Cesium')
// Cesium's own minified ESM build of the same version (one file, the same 1352 exports as the sources).
const cesiumMinifiedEntry = path.join(cesiumBuildRoot, 'index.js')
// Cesium's prebuilt files, including the copied workers, open with its Apache-2.0 license header. Bundling from the
// sources drops it, so the Cesium chunk gets the same header back, read from the installed package.
const readCesiumLicenseHeader = () => {
  const head = readFileSync(cesiumMinifiedEntry, 'utf8').slice(0, 4096)
  const end = head.indexOf('*/')
  if (!head.startsWith('/**') || end < 0 || !head.includes('@license')) throw new Error('Cesium license header not found in Build/Cesium/index.js')
  return head.slice(0, end + 2)
}

// `vite preview` serves dist, and dist may be a personal build carrying private data and original media. In every mode
// the preview server therefore grants no CORS, and batch 1's cross-site guard runs ahead of its own middlewares
// (batch 2B). Same-origin pages, including the public build's preview, work as before. Dev servers and builds are untouched.
const previewHardening = async (isPreview: boolean | undefined): Promise<{ preview?: UserConfig['preview']; plugins: Plugin[] }> => {
  if (!isPreview) return { plugins: [] }
  // @ts-expect-error Node-only module outside the browser TypeScript project.
  const { crossSiteRequestGuard } = await import('./scripts/local-editor-request-guard.mjs')
  return {
    preview: { cors: false },
    plugins: [{
      name: 'starmap-preview-cross-site-guard',
      configurePreviewServer(server) {
        server.middlewares.use(crossSiteRequestGuard)
      },
    }],
  }
}

// https://vite.dev/config/
export default defineConfig(async ({ mode, command, isPreview }): Promise<UserConfig> => {
  const hardening = await previewHardening(isPreview)
  // @ts-expect-error Node-only Vite plugin is outside the browser TypeScript project.
  const { travelAtlasLocalEditor } = await import('./scripts/local-editor-plugin.mjs')
  // @ts-expect-error Node-only profile helper is outside the browser TypeScript project.
  const { getPrivatePaths } = await import('./scripts/private-profile.mjs')
  // @ts-expect-error Node-only Vite plugin is outside the browser TypeScript project.
  const { cesiumStatic } = await import('./scripts/cesium-static-plugin.mjs')
  const profile = mode === 'personal' ? 'personal' : 'public'
  const privatePaths = getPrivatePaths()
  const envDir = profile === 'personal' ? privatePaths.configRoot : false
  const personalEnv = profile === 'personal' ? loadEnv(mode, envDir, '') : {}

  return {
    ...(hardening.preview ? { preview: hardening.preview } : {}),
    // Public mode never reads repository-local .env files. Hosting variables from process.env still work.
    envDir,
    define: {
      CESIUM_BASE_URL: JSON.stringify(`/${cesiumBaseUrl}`),
    },
    plugins: [
      ...hardening.plugins,
      travelAtlasLocalEditor({
        profile,
        privateRoot: privatePaths.root,
        cesiumAccessToken: personalEnv.VITE_CESIUM_ION_TOKEN,
        forceSample: (personalEnv.VITE_TRAVEL_ATLAS_DATA_MODE ?? process.env.VITE_TRAVEL_ATLAS_DATA_MODE) === 'sample',
      }),
      react(),
      tailwindcss(),
      cesiumStatic({ baseUrl: cesiumBaseUrl, sourceRoot: cesiumBuildRoot }),
    ],
    build: {
      rolldownOptions: {
        output: {
          // Cesium and the packages it imports get their own chunk. An application change that uses no further Cesium
          // API leaves that chunk's file name, and every cached copy of it, unchanged.
          codeSplitting: {
            groups: [{ name: 'cesium', test: /[\\/]node_modules[\\/](?:cesium|@cesium)[\\/]/ }],
          },
          postBanner: (chunk) => chunk.name === 'cesium' ? readCesiumLicenseHeader() : '',
        },
      },
    },
    // Development only (batch 4B, E1): `cesium` imports, the app's and resium's, load Cesium's minified build (4.7 MB)
    // instead of the 12.5 MB bundle and 20 MB source map that dependency optimisation makes from the sources. Builds still
    // bundle the sources, as above.
    ...(command === 'serve' ? { resolve: { alias: [{ find: /^cesium$/, replacement: cesiumMinifiedEntry }] } } : {}),
    server: {
      // The personal profile serves private data, so no other origin gets a CORS grant (Vite 8 otherwise allows any
      // localhost, 127.0.0.1 or [::1] origin). The local editor's cross-site guard covers what CORS cannot.
      ...(profile === 'personal' ? { cors: false } : {}),
      watch: {
        ignored: [
          '**/public/media/user/**',
        ],
      },
    },
  }
})
