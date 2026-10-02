import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
import { DEFAULT_UI_LOCALE, EN_UI_LOCALE } from '../src/data/uiLocale.ts'

const uiAttributes = new Set(['placeholder', 'title', 'aria-label', 'aria-description', 'alt', 'label'])
const normalize = (key) => key.replace(/_(one|other)$/, '')
const argumentsOf = (text) => [...new Set([...text.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((match) => match[1]))].sort().join(',')
const flatten = (object, prefix = '') => Object.fromEntries(Object.entries(object).flatMap(([key, value]) => {
  const name = prefix ? `${prefix}.${key}` : key
  return typeof value === 'string' ? [[name, value]] : Object.entries(flatten(value, name))
}))

/** All registered namespaces participate; adding a namespace never needs a test allowlist update. */
export function checkResources(resources) {
  const issues = []
  const zh = resources[DEFAULT_UI_LOCALE] ?? {}
  const en = resources[EN_UI_LOCALE] ?? {}
  for (const namespace of new Set([...Object.keys(zh), ...Object.keys(en)])) {
    if (!zh[namespace] || !en[namespace]) {
      issues.push(`${namespace}: namespace must exist in zh and en`)
      continue
    }
    const dictionaries = { zh: flatten(zh[namespace]), en: flatten(en[namespace]) }
    for (const locale of ['zh', 'en']) {
      const peer = locale === 'zh' ? 'en' : 'zh'
      for (const [key, value] of Object.entries(dictionaries[locale])) {
        const base = normalize(key)
        const candidates = Object.entries(dictionaries[peer]).filter(([other]) => normalize(other) === base)
        if (!value.trim()) issues.push(`${locale}/${namespace}:${key}: empty translation`)
        if (!candidates.length) issues.push(`${locale}/${namespace}:${key}: missing ${peer} translation`)
        for (const [other, translated] of candidates) {
          if (argumentsOf(value) !== argumentsOf(translated)) issues.push(`${namespace}:${key}/${other}: interpolation arguments differ`)
        }
        if (key.endsWith('_other') && locale === 'en' && !Object.hasOwn(dictionaries.en, `${base}_one`)) {
          issues.push(`en/${namespace}:${base}: English plural needs _one and _other`)
        }
        if (key.endsWith('_one') && locale === 'en' && !Object.hasOwn(dictionaries.en, `${base}_other`)) {
          issues.push(`en/${namespace}:${base}: English plural needs _one and _other`)
        }
      }
    }
  }
  return [...new Set(issues)]
}

function hasKey(resources, key, defaultNamespace) {
  const separator = key.indexOf(':')
  const namespace = separator < 0 ? defaultNamespace : key.slice(0, separator)
  const name = separator < 0 ? key : key.slice(separator + 1)
  return [DEFAULT_UI_LOCALE, EN_UI_LOCALE].every((locale) => {
    const dictionary = flatten(resources[locale]?.[namespace] ?? {})
    return Object.hasOwn(dictionary, name) || Object.hasOwn(dictionary, `${name}_other`)
  })
}

// Only the exact literal in the exact file is exempt. These are not translated UI sentences.
export const literalExceptions = [
  { file: 'src/components/AtlasHeader.tsx', literal: 'StarMap', reason: 'Product name' },
  { file: 'src/components/InfoCard.tsx', literal: 'StarMap', reason: 'Product name in the world overview' },
  { file: 'src/components/LanguageSelector.tsx', literal: '中文', reason: 'Language autonym remains recognizable in either locale' },
  { file: 'src/components/LanguageSelector.tsx', literal: 'English', reason: 'Language autonym remains recognizable in either locale' },
  { file: 'src/components/MouseControlGuide.tsx', literal: 'Ctrl', reason: 'Physical keyboard modifier on gesture diagram' },
  { file: 'src/components/InfoCard.tsx', literal: '© OpenStreetMap contributors', reason: 'Required provider attribution' },
  { file: 'src/components/WantToGoAddDialog.tsx', literal: '© OpenStreetMap contributors', reason: 'Required provider attribution' },
  { file: 'src/components/UpdateChecker.tsx', literal: 'v', reason: 'Version-number prefix' },
  { file: 'src/components/DroneMediaCard.tsx', literal: 'MiB', reason: 'Standard binary-size unit' },
  { file: 'src/components/CompassButton.tsx', literal: 'N', reason: 'International compass north symbol' },
]

const parse = (file, source) => ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
const unwrap = (node) => ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node) ? unwrap(node.expression) : node
const walk = (node, visitor) => { visitor(node); ts.forEachChild(node, (child) => walk(child, visitor)) }
const propertyName = (node) => ts.isIdentifier(node) || ts.isStringLiteral(node) ? node.text : ''

function localDeclaration(identifier) {
  for (let scope = identifier.parent; scope; scope = scope.parent) {
    if (!ts.isFunctionLike(scope) && !ts.isSourceFile(scope)) continue
    if (ts.isFunctionLike(scope) && scope.parameters.some((parameter) => {
      const names = []
      walk(parameter.name, (binding) => { if (ts.isIdentifier(binding)) names.push(binding.text) })
      return names.includes(identifier.text)
    })) return undefined
    let declaration
    const visit = (child) => {
      if (child !== scope && ts.isFunctionLike(child)) return
      if (ts.isVariableDeclaration(child) && (child.parent.flags & ts.NodeFlags.Const)) {
        if (ts.isIdentifier(child.name) && child.name.text === identifier.text) declaration = child
        if (ts.isObjectBindingPattern(child.name) && child.name.elements.some((binding) => ts.isIdentifier(binding.name) && binding.name.text === identifier.text)) declaration = child
      }
      ts.forEachChild(child, visit)
    }
    visit(scope)
    if (declaration) return declaration
  }
  return undefined
}

const localInitializer = (identifier) => {
  const declaration = localDeclaration(identifier)
  return declaration && ts.isIdentifier(declaration.name) ? declaration.initializer : undefined
}

function objectProperty(node, property, seen = new Set()) {
  if (!node || seen.has(node)) return undefined
  seen.add(node)
  node = unwrap(node)
  if (ts.isIdentifier(node)) return objectProperty(localInitializer(node), property, seen)
  if (ts.isPropertyAccessExpression(node)) return objectProperty(objectProperty(node.expression, node.name.text, seen), property, seen)
  if (!ts.isObjectLiteralExpression(node)) return undefined
  for (const member of [...node.properties].reverse()) {
    if (ts.isSpreadAssignment(member)) {
      const result = objectProperty(member.expression, property, seen)
      // An unknown runtime spread may overwrite preceding source constants.
      return result
    }
    if (propertyName(member.name) !== property) continue
    if (ts.isPropertyAssignment(member)) return member.initializer
    if (ts.isShorthandPropertyAssignment(member)) return localInitializer(member.name)
  }
  return undefined
}

function finiteStrings(node, allowUndefined = false, seen = new Set()) {
  if (!node || seen.has(node)) throw new Error('Cannot enumerate an unresolved or cyclic value')
  seen = new Set(seen).add(node)
  node = unwrap(node)
  if (ts.isStringLiteralLike(node)) return [node.text]
  if (ts.isArrayLiteralExpression(node)) return node.elements.flatMap((element) => finiteStrings(element, allowUndefined, seen))
  if (ts.isConditionalExpression(node)) return [...finiteStrings(node.whenTrue, allowUndefined, seen), ...finiteStrings(node.whenFalse, allowUndefined, seen)]
  if (ts.isIdentifier(node) && node.text === 'undefined' && allowUndefined) return []
  if (ts.isIdentifier(node)) return finiteStrings(localInitializer(node), allowUndefined, seen)
  if (ts.isPropertyAccessExpression(node)) return finiteStrings(objectProperty(node.expression, node.name.text), allowUndefined, seen)
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'filter') return finiteStrings(node.expression.expression, allowUndefined, seen)
  throw new Error(`Cannot enumerate dynamic value: ${node.getText()}`)
}

/** Read finite option declarations as syntax, never import map/provider modules or initialize the browser. */
function declaredValues(files, filename, variable, property) {
  const source = files.get(filename)
  if (!source) throw new Error(`Dynamic-key contract source missing: ${filename}`)
  const values = []
  walk(parse(filename, source), (node) => {
    if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || node.name.text !== variable || !node.initializer) return
    const objects = (child, seen = new Set()) => {
      if (!child || seen.has(child)) throw new Error(`Cannot enumerate dynamic-key declaration: ${filename} / ${variable}`)
      seen = new Set(seen).add(child)
      child = unwrap(child)
      if (ts.isArrayLiteralExpression(child)) child.elements.forEach((element) => objects(element, seen))
      else if (ts.isConditionalExpression(child)) { objects(child.whenTrue, seen); objects(child.whenFalse, seen) }
      else if (ts.isIdentifier(child)) objects(localInitializer(child), seen)
      else if (ts.isSpreadElement(child)) objects(child.expression, seen)
      else if (ts.isObjectLiteralExpression(child)) {
        let found = false
        for (const member of child.properties) {
          if (ts.isSpreadAssignment(member)) { objects(member.expression, seen); found = true }
          if (propertyName(member.name) !== property) continue
          found = true
          const expression = ts.isPropertyAssignment(member) ? member.initializer
            : ts.isShorthandPropertyAssignment(member) ? localInitializer(member.name) : undefined
          values.push(...finiteStrings(expression))
        }
        if (!found) throw new Error(`Dynamic-key option lacks ${property}: ${filename} / ${variable}`)
      }
      else throw new Error(`Cannot enumerate dynamic-key declaration: ${filename} / ${variable} / ${child.getText()}`)
    }
    if (!property) values.push(...finiteStrings(node.initializer, true))
    else objects(node.initializer)
  })
  if (!values.length) throw new Error(`Dynamic-key contract has no finite values: ${filename} / ${variable}`)
  return [...new Set(values)]
}

/** Each dynamic expression has a bounded declaration. New option values are checked automatically. */
export function dynamicKeyContracts(files) {
  const values = (file, variable, property) => declaredValues(files, file, variable, property)
  const local = (file, variable, property) => values(`src/components/${file}.tsx`, variable, property)
  const sources = [...values('src/data/mapSources.ts', 'mapSourceOptions', 'id'), ...values('src/extensions/mapSources.ts', 'googleOption', 'id')]
  const layerKeys = values('src/worldgraph/layers.ts', 'officialLayers', 'labelKey')
  const argumentValues = (file, called, position) => {
    const source = files.get(file)
    if (!source) throw new Error(`Dynamic-key contract source missing: ${file}`)
    const result = []
    walk(parse(file, source), (node) => {
      if (!ts.isCallExpression(node) || node.expression.getText() !== called) return
      const argument = node.arguments[position]
      if (!argument) throw new Error(`Dynamic-key contract needs ${called} argument in ${file}`)
      result.push(...finiteStrings(argument))
    })
    if (!result.length) throw new Error(`Dynamic-key contract has no ${called} choices in ${file}`)
    return [...new Set(result)]
  }
  const propertyValues = (file, property) => {
    const result = []
    walk(parse(file, files.get(file) ?? ''), (node) => {
      if (ts.isPropertyAssignment(node) && propertyName(node.name) === property) {
        result.push(...finiteStrings(node.initializer, true))
      }
    })
    return result
  }
  const contract = (file, expression, keys, reason) => ({ file: `src/components/${file}.tsx`, expression, keys, reason })
  return [
    contract('AtlasHeader', 'item.id', local('AtlasHeader', 'navItems', 'id'), 'Navigation option ids'),
    contract('CollectionPage', 'option.id', [...local('CollectionPage', 'statusOptions', 'id'), ...local('CollectionPage', 'sortOptions', 'id')], 'Filter and sort option ids'),
    contract('JourneyViewToggle', '`journey:${option.id}`', local('JourneyViewToggle', 'options', 'id').map((id) => `journey:${id}`), 'Journey mode ids'),
    contract('InfoCard', "`details:continent${continent.replaceAll(' ', '')}`", local('InfoCard', 'continentRules', 'continent').map((name) => `details:continent${name.replaceAll(' ', '')}`), 'Finite continent classification'),
    contract('MouseControlGuide', 'control.key', local('MouseControlGuide', 'controls', 'key'), 'Gesture instruction keys'),
    contract('MouseControlGuide', 'control.label', local('MouseControlGuide', 'controls', 'label'), 'Gesture action keys'),
    contract('PrivateDataNotice', 'key', local('PrivateDataNotice', 'lines'), 'Finite migration or empty-state lines'),
    contract('LayerPanel', 'layer.labelKey', layerKeys, 'Official layer registry label keys'),
    contract('LayerPanel', 'wantToGoLayer.labelKey', layerKeys, 'Official layer registry label keys'),
    contract('CollectionPage', 'wantToGoLayer.labelKey', layerKeys, 'Official layer registry label keys'),
    ...['`source.${activeOption?.id ?? \'local\'}.label`', '`source.${option.id}.label`', '`source.${option.id}.description`'].map((expression) =>
      contract('MapSourceSwitcher', expression, sources.map((id) => `mapMenu:source.${id}.${expression.endsWith('.description`') ? 'description' : 'label'}`), 'Finite provider option ids')),
    contract('CollectionPage', '`collection:${failureKey}`', argumentValues('src/components/CollectionPage.tsx', 'runWrite', 1).map((key) => `collection:${key}`), 'runWrite failure choices'),
    contract('LayerPanel', '`mapMenu:${failureKey}`', argumentValues('src/components/LayerPanel.tsx', 'runHiddenItemAction', 1).map((key) => `mapMenu:${key}`), 'Hidden-item operation failure choices'),
    contract('DroneMediaCard', 'key', [...local('DroneMediaCard', 'readErrors'), ...propertyValues('src/components/DroneMediaCard.tsx', 'errorKeys')], 'Per-file metadata reader error keys'),
    contract('DronePanoramaModal', 'key', values('src/i18n/mediaViewerOptions.ts', 'panoramaLanguageKeys'), 'Every third-party panorama UI language option'),
  ]
}

export function checkUiSource(source, file, resources, { exceptions = literalExceptions, contracts = [] } = {}) {
  const syntax = parse(file, source)
  const issues = []
  const location = (node) => syntax.getLineAndCharacterOfPosition(node.getStart(syntax)).line + 1
  const issue = (node, message) => issues.push(`${file}:${location(node)}: ${message}`)
  const literal = (node, text) => {
    const value = text.replace(/\s+/g, ' ').trim()
    if (!/\p{L}/u.test(value)) return
    if (exceptions.some((exception) => exception.file === file && exception.literal === value && exception.reason)) return
    issue(node, `fixed UI text must use a translation: ${JSON.stringify(value)}`)
  }
  const visible = (node, seen = new Set()) => {
    if (!node) return
    node = unwrap(node)
    if (seen.has(node)) return
    seen.add(node)
    if (ts.isStringLiteralLike(node)) literal(node, node.text)
    else if (ts.isIdentifier(node)) visible(localInitializer(node), seen)
    else if (ts.isPropertyAccessExpression(node)) visible(objectProperty(node.expression, node.name.text), seen)
    else if (ts.isElementAccessExpression(node) && node.argumentExpression && ts.isStringLiteralLike(node.argumentExpression)) visible(objectProperty(node.expression, node.argumentExpression.text), seen)
    else if (ts.isConditionalExpression(node)) { visible(node.whenTrue, seen); visible(node.whenFalse, seen) }
    else if (ts.isBinaryExpression(node) && [ts.SyntaxKind.PlusToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.AmpersandAmpersandToken].includes(node.operatorToken.kind)) {
      // The left side of && is a visibility condition, not rendered text.
      if (node.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken) visible(node.left, seen)
      visible(node.right, seen)
    } else if (ts.isTemplateExpression(node)) {
      literal(node, [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(' '))
      for (const span of node.templateSpans) visible(span.expression, seen)
    }
    // Unresolved identifiers / properties are runtime data or prepared display values;
    // calls are handled by the separate translation-key walk below.
  }
  const namespaceOf = (node) => {
    for (let scope = node.parent; scope; scope = scope.parent) {
      if (!ts.isFunctionLike(scope) && !ts.isSourceFile(scope)) continue
      const namespaces = new Set()
      let commonHook = false
      const visit = (child) => {
        if (child !== scope && ts.isFunctionLike(child)) return
        if (ts.isCallExpression(child) && ts.isIdentifier(child.expression)) {
          if (child.expression.text === 'useTranslation') {
            const argument = child.arguments[0]
            const first = argument && ts.isArrayLiteralExpression(argument) ? argument.elements[0] : argument
            if (first && ts.isStringLiteralLike(first)) namespaces.add(first.text)
          }
          if (child.expression.text === 'useUiLocale') commonHook = true
        }
        ts.forEachChild(child, visit)
      }
      visit(scope)
      if (namespaces.size === 1) return [...namespaces][0]
      if (namespaces.size > 1) return undefined
      if (commonHook) return 'common'
    }
    return undefined
  }
  const hookNamespace = (call) => {
    if (!call || !ts.isCallExpression(call) || !ts.isIdentifier(call.expression)) return undefined
    if (call.expression.text === 'useUiLocale') return { namespace: 'common' }
    if (call.expression.text !== 'useTranslation') return undefined
    const argument = call.arguments[0]
    if (!argument) return { namespace: 'common' }
    const first = ts.isArrayLiteralExpression(argument) ? argument.elements[0] : argument
    return { namespace: first && ts.isStringLiteralLike(first) ? first.text : undefined }
  }
  const translationBinding = (expression, seen = new Set()) => {
    if (!ts.isIdentifier(expression) || seen.has(expression)) return undefined
    seen.add(expression)
    const declaration = localDeclaration(expression)
    if (declaration && ts.isObjectBindingPattern(declaration.name)) {
      const binding = declaration.name.elements.find((element) => ts.isIdentifier(element.name) && element.name.text === expression.text)
      if (binding && propertyName(binding.propertyName ?? binding.name) === 't') return hookNamespace(declaration.initializer)
    }
    if (declaration && ts.isIdentifier(declaration.name) && declaration.initializer && ts.isIdentifier(declaration.initializer)) {
      return translationBinding(declaration.initializer, seen)
    }
    // UI helpers may receive t as a parameter; fully qualified keys remain checkable.
    return expression.text === 't' ? { namespace: namespaceOf(expression) } : undefined
  }
  const callNamespace = (node, initial) => {
    const options = node.arguments[1] && unwrap(node.arguments[1])
    if (!options || !ts.isObjectLiteralExpression(options)) return initial
    const setting = options.properties.find((property) => ts.isPropertyAssignment(property) && propertyName(property.name) === 'ns')
    if (!setting) return initial
    const expression = unwrap(setting.initializer)
    const first = ts.isArrayLiteralExpression(expression) ? expression.elements[0] : expression
    if (first && ts.isStringLiteralLike(first)) return first.text
    issue(setting, 'translation namespace option must be statically known')
    return undefined
  }
  const key = (node, defaultNamespace) => {
    if (!node) return
    node = unwrap(node)
    if (ts.isConditionalExpression(node)) { key(node.whenTrue, defaultNamespace); key(node.whenFalse, defaultNamespace); return }
    if (ts.isStringLiteralLike(node)) {
      if (!hasKey(resources, node.text, defaultNamespace)) issue(node, `translation key missing in zh/en: ${node.text}`)
      return
    }
    const contract = contracts.find((candidate) => candidate.file === file && candidate.expression === node.getText(syntax))
    if (!contract) { issue(node, `dynamic translation key needs a finite contract: ${node.getText(syntax)}`); return }
    for (const name of contract.keys) if (!hasKey(resources, name, defaultNamespace)) issue(node, `dynamic translation key missing in zh/en: ${name}`)
  }
  walk(syntax, (node) => {
    if (ts.isJsxText(node)) literal(node, node.text)
    if (ts.isJsxExpression(node) && node.expression && !ts.isJsxAttribute(node.parent)) visible(node.expression)
    if (ts.isJsxAttribute(node) && uiAttributes.has(node.name.getText(syntax)) && node.initializer) {
      visible(ts.isJsxExpression(node.initializer) ? node.initializer.expression : node.initializer)
    }
    if (ts.isCallExpression(node)) {
      const called = node.expression.getText(syntax)
      const translator = translationBinding(node.expression)
      if (translator || called === 'i18n.t') key(node.arguments[0], callNamespace(node, called === 'i18n.t' ? 'common' : translator.namespace))
      if (called === 'editorErrorNotice') key(node.arguments[1], namespaceOf(node))
      if (['window.confirm', 'window.alert', 'setNotice', 'setEditorNotice'].includes(called)) visible(node.arguments[0])
    }
    if (ts.isPropertyAssignment(node) && propertyName(node.name) === 'key') {
      const notice = ts.isCallExpression(node.parent.parent) && ['setNotice', 'setEditorNotice'].includes(node.parent.parent.expression.getText(syntax))
      if (notice || (ts.isStringLiteralLike(node.initializer) && node.initializer.text.includes(':'))) {
        if (notice && ts.isStringLiteralLike(node.initializer) && !node.initializer.text.includes(':')) issue(node, 'notice translation key must include its namespace')
        key(node.initializer, namespaceOf(node))
      }
    }
  })
  return [...new Set(issues)]
}

/** Follow only local source imports from the live entry; no directory scan, data import, or private overlay. */
export async function activeSourceFiles(root, entry = 'src/main.tsx') {
  const files = new Map()
  const pending = [entry]
  const resolve = async (from, reference) => {
    if (!reference.startsWith('.')) return undefined
    const base = path.resolve(root, path.dirname(from), reference)
    if (!base.startsWith(path.resolve(root, 'src') + path.sep)) return undefined
    for (const candidate of [base, `${base}.tsx`, `${base}.ts`, path.join(base, 'index.tsx'), path.join(base, 'index.ts')]) {
      if (!/\.(tsx?|mjs)$/.test(candidate)) continue
      try { if ((await stat(candidate)).isFile()) return path.relative(root, candidate).split(path.sep).join('/') } catch { /* Try the next source extension. */ }
    }
    return undefined
  }
  while (pending.length) {
    const file = pending.pop()
    if (files.has(file)) continue
    const source = await readFile(path.join(root, file), 'utf8')
    files.set(file, source)
    const references = []
    walk(parse(file, source), (node) => {
      if (ts.isImportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        const clause = node.importClause
        const bindings = clause?.namedBindings
        const onlyTypes = clause?.isTypeOnly || (!clause?.name && bindings && ts.isNamedImports(bindings)
          && bindings.elements.length > 0 && bindings.elements.every((element) => element.isTypeOnly))
        if (!onlyTypes) references.push(node.moduleSpecifier.text)
      }
      if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) references.push(node.moduleSpecifier.text)
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && ts.isStringLiteral(node.arguments[0])) references.push(node.arguments[0].text)
    })
    for (const reference of references) {
      const dependency = await resolve(file, reference)
      if (dependency) pending.push(dependency)
    }
  }
  return files
}

export async function checkProject(root) {
  const { resources } = await import(pathToFileURL(path.join(root, 'src/i18n/resources.ts')).href)
  const files = await activeSourceFiles(root)
  const contracts = dynamicKeyContracts(files)
  const issues = checkResources(resources)
  const uiFiles = [...files].filter(([file]) => file.endsWith('.tsx') && file !== 'src/components/AtlasGlobe.tsx')
  for (const [file, source] of uiFiles) issues.push(...checkUiSource(source, file, resources, { contracts }))
  return { issues, uiFiles: uiFiles.length, namespaces: Object.keys(resources.en).length }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const result = await checkProject(path.resolve(import.meta.dirname, '..'))
    if (result.issues.length) {
      console.error(result.issues.join('\n'))
      process.exitCode = 1
    } else console.log(`StarMap i18n check passed: ${result.uiFiles} active UI modules, ${result.namespaces} bilingual namespaces.`)
  } catch (error) {
    console.error(`StarMap i18n check failed: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
