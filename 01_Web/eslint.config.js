import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
    },
    rules: {
      // 3C-5 D: the App's data are hook values (src/data/appStore.ts), so a missing dependency is a stale view of the data.
      'react-hooks/exhaustive-deps': 'error',
    },
  },
  // 3C-5 D: components read the data only through hooks; the store itself (getSnapshot outside React's subscription)
  // stays in src/data/.
  {
    files: ['src/components/**/*.{ts,tsx}', 'src/App.tsx', 'src/i18n/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', {
        paths: [{ name: '../data/appStore', importNames: ['appStore'], message: '3C-5 D: read the data through the hooks (useAppSnapshot, useTravelAtlas, …), not the store.' },
          { name: '../data/appStore.ts', importNames: ['appStore'], message: '3C-5 D: read the data through the hooks (useAppSnapshot, useTravelAtlas, …), not the store.' },
          { name: './data/appStore', importNames: ['appStore'], message: '3C-5 D: read the data through the hooks (useAppSnapshot, useTravelAtlas, …), not the store.' },
          { name: './data/appStore.ts', importNames: ['appStore'], message: '3C-5 D: read the data through the hooks (useAppSnapshot, useTravelAtlas, …), not the store.' }],
        patterns: [{ group: ['**/appStoreCore', '**/appStoreCore.ts'], message: '3C-5 D: read the data through the hooks of src/data/appStore.ts.' }],
      }],
    },
  },
  {
    files: ['scripts/**/*.mjs', 'tests/browser/**/*.mjs', 'playwright.config.mjs'],
    extends: [js.configs.recommended],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ['tests/browser/**/*.mjs'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  // FR-MOD（PRD v0.4 §FR-MOD / 战略 v0.2 D25）：src/worldgraph/** 是环境无关的
  // World Graph Core，禁止反向依赖表现层、应用单例与运行环境。
  // 这是约束不是重构：只加规则，不移动文件（FR-MOD-3）。
  // 放宽任何一条都等于修改 D25，须先改战略文档 §9.5.3（FR-MOD-4）。
  {
    files: ['src/worldgraph/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/components', '**/components/**'],
              message:
                'FR-MOD: worldgraph Core 不得依赖 src/components/**（表现层）。Core 只能被 UI 依赖，不能反过来。',
            },
            {
              group: ['**/data/travelAtlas', '**/data/travelAtlas.*'],
              message:
                'FR-MOD: worldgraph Core 不得 import src/data/travelAtlas.ts（应用单例，且依赖 virtual:starmap-private-data 与 import.meta.env，一旦引入 node --test 立刻失效）。请由调用方以参数传入。',
            },
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'MetaProperty[meta.name="import"][property.name="meta"]',
          message:
            'FR-MOD: worldgraph Core 不得使用 import.meta / import.meta.env（运行环境耦合）。需要配置请由调用方以参数传入。',
        },
        {
          selector: 'ImportExpression[source.value=/(^|[/])components([/]|$)/]',
          message:
            'FR-MOD: worldgraph Core 不得动态 import() src/components/**。',
        },
        {
          selector: 'ImportExpression[source.value=/(^|[/])data[/]travelAtlas([.]|$)/]',
          message:
            'FR-MOD: worldgraph Core 不得动态 import() src/data/travelAtlas.ts。',
        },
      ],
    },
  },
])
