import { defineConfig, loadEnv } from 'vite'
import type { Plugin, UserConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import cesium from 'vite-plugin-cesium'

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
export default defineConfig(async ({ mode, isPreview }): Promise<UserConfig> => {
  const hardening = await previewHardening(isPreview)
  // @ts-expect-error Node-only Vite plugin is outside the browser TypeScript project.
  const { travelAtlasLocalEditor } = await import('./scripts/local-editor-plugin.mjs')
  // @ts-expect-error Node-only profile helper is outside the browser TypeScript project.
  const { getPrivatePaths } = await import('./scripts/private-profile.mjs')
  const profile = mode === 'personal' ? 'personal' : 'public'
  const privatePaths = getPrivatePaths()
  const envDir = profile === 'personal' ? privatePaths.configRoot : false
  const personalEnv = profile === 'personal' ? loadEnv(mode, envDir, '') : {}

  return {
    ...(hardening.preview ? { preview: hardening.preview } : {}),
    // Public mode never reads repository-local .env files. Hosting variables from process.env still work.
    envDir,
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
      cesium(),
    ],
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
