import { defineConfig, loadEnv } from 'vite'
import type { UserConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import cesium from 'vite-plugin-cesium'
// @ts-expect-error Node-only Vite plugin is intentionally kept outside the browser TypeScript project.
import { repositoryPreviewPlugin } from './scripts/repository-preview-plugin.mjs'

// https://vite.dev/config/
export default defineConfig(async ({ mode, command }): Promise<UserConfig> => {
  const repositoryPreview = repositoryPreviewPlugin({ mode, command })
  if (mode === 'repository-preview') {
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
      repositoryPreview,
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
