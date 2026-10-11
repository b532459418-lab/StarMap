import { defineConfig, loadEnv } from 'vite'
import type { Plugin, UserConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import cesium from 'vite-plugin-cesium'

const repositoryPreviewId = 'virtual:starmap-repository-preview'

// Outside repository-preview mode the preview module is always `null`. This inline plugin emits the same
// module source as the preview plugin's disabled path, without loading it (it pulls in node:sqlite and the
// experimental world-store modules).
const nullRepositoryPreview = (): Plugin => ({
  name: 'starmap-repository-preview-null',
  resolveId(id) {
    if (id === repositoryPreviewId) return '\0' + id
  },
  load(id) {
    if (id === '\0' + repositoryPreviewId) return 'export const repositoryPreview = null;'
  },
})

// https://vite.dev/config/
export default defineConfig(async ({ mode, command }): Promise<UserConfig> => {
  if (mode === 'repository-preview') {
    // Vite bundles this config without code splitting, so a literal import() here would still be inlined and its
    // node:sqlite import hoisted to the top of the config bundle. A runtime URL keeps the preview plugin out of
    // the bundle: Node loads it, and node:sqlite with it, only in this mode.
    const previewPluginUrl = new URL('./scripts/repository-preview-plugin.mjs', import.meta.url).href
    const { repositoryPreviewPlugin } = await import(previewPluginUrl)
    const repositoryPreview = repositoryPreviewPlugin({ mode, command })
    return {
      // This branch neither imports the personal editor nor resolves private paths.
      envDir: false,
      envPrefix: [],
      define: {
        'import.meta.env.VITE_MAP_SOURCE': JSON.stringify('local'),
        'import.meta.env.VITE_CESIUM_ION_TOKEN': JSON.stringify(''),
        'import.meta.env.VITE_TIANDITU_TOKEN': JSON.stringify(''),
        'import.meta.env.VITE_TRAVEL_ATLAS_DATA_MODE': JSON.stringify(''),
      },
      plugins: [repositoryPreview, react(), tailwindcss(), cesium()],
      server: {
        watch: { ignored: ['**/public/media/user/**'] },
      },
    }
  }
  // Preserve the original profiles, including their options, after mode selection.
  // @ts-expect-error Node-only Vite plugin is outside the browser TypeScript project.
  const { travelAtlasLocalEditor } = await import('./scripts/local-editor-plugin.mjs')
  // @ts-expect-error Node-only profile helper is outside the browser TypeScript project.
  const { getPrivatePaths } = await import('./scripts/private-profile.mjs')
  const profile = mode === 'personal' ? 'personal' : 'public'
  const privatePaths = getPrivatePaths()
  const envDir = profile === 'personal' ? privatePaths.configRoot : false
  const personalEnv = profile === 'personal' ? loadEnv(mode, envDir, '') : {}

  return {
    // Public mode never reads repository-local .env files. Hosting variables from process.env still work.
    envDir,
    plugins: [
      nullRepositoryPreview(),
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
      watch: {
        ignored: [
          '**/public/media/user/**',
        ],
      },
    },
  }
})
