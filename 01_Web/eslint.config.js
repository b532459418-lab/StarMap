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
  },
  {
    files: ['scripts/**/*.mjs'],
    extends: [js.configs.recommended],
    languageOptions: {
      globals: globals.node,
    },
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
  // RFC-LOC-1 PR1：src/data/derive/travelAtlas.ts 里的这四个函数是「按名字推导身份的旧规则」
  // （RFC-LOC-1 §1.1），PR5 删除。只允许派生层内部（src/data/derive/**，含其测试）引用；
  // PR2：Legacy Adapter 与它的共享选择模块（RFC §3.6「原则 5 的过渡期例外」）加入白名单，PR5 一起删除。
  // 用 @typescript-eslint 版的规则而不是核心 no-restricted-imports：同名规则在后面的块里会整体
  // 覆盖前面块的选项，那样会替换掉上面 FR-MOD 对 src/worldgraph/** 的限制。
  {
    files: ['**/*.{ts,tsx,mjs}'],
    ignores: [
      'src/data/derive/**',
      'src/data/canonical/legacyAdapter.ts',
      'src/data/canonical/legacyAdapter.test.ts',
      'src/data/canonical/representatives.ts',
    ],
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/derive/travelAtlas', '**/derive/travelAtlas.ts'],
              importNames: ['countryKeyForRecord', 'cityKeyForRecord', 'getJourneyId', 'slugify'],
              message: 'RFC-LOC-1：按名字推导身份的旧规则只允许派生层内部使用（PR5 删除）。',
            },
          ],
        },
      ],
    },
  },
])
