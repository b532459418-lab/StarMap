/// <reference types="node" />

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import ts from 'typescript'
import { UI_LOCALE } from './uiLocale.ts'

test('The UI locale is defined once; other simplified Chinese tags are names in data', () => {
  assert.equal(UI_LOCALE, 'zh-Hans')
  const root = new URL('../', import.meta.url)
  const files = readdirSync(root, { recursive: true }).filter((file) => typeof file === 'string' && /\.tsx?$/.test(file) && !file.endsWith('.test.ts')) as string[]
  for (const file of files) {
    if (file.replaceAll('\\', '/') === 'data/uiLocale.ts') continue
    const source = ts.createSourceFile(file, readFileSync(new URL(file.replaceAll('\\', '/'), root), 'utf8'), ts.ScriptTarget.Latest, true)
    const visit = (node: ts.Node) => {
      if (ts.isStringLiteral(node) && node.text === UI_LOCALE) {
        const parent = node.parent
        const dataTag = (ts.isVariableDeclaration(parent) && parent.name.getText(source) === 'ZH')
          || (ts.isPropertyAssignment(parent) && parent.name === node)
          || (ts.isElementAccessExpression(parent) && parent.argumentExpression === node)
        assert.ok(dataTag, `${file}: the UI locale must come from UI_LOCALE`)
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
})
