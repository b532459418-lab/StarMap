import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { activeSourceFiles, checkResources, checkUiSource, dynamicKeyContracts } from './i18n-check.mjs'

const dictionaries = (zh, en) => ({ 'zh-Hans': { common: zh }, en: { common: en } })
const resources = dictionaries({ save: '保存', cancel: '取消', count_other: '{{count}} 项' }, { save: 'Save', cancel: 'Cancel', count_one: '{{count}} item', count_other: '{{count}} items' })
const check = (source, options) => checkUiSource(source, 'src/components/Fixture.tsx', resources, options)

test('every newly registered namespace must be bilingual, with nonempty values and matching interpolation', () => {
  assert.deepEqual(checkResources(resources), [])
  assert.match(checkResources({ ...resources, en: { ...resources.en, newFeature: { label: 'New' } } }).join('\n'), /newFeature: namespace/)
  assert.match(checkResources(dictionaries({ save: '保存' }, { save: 'Save', newKey: 'New' })).join('\n'), /newKey: missing zh/)
  assert.match(checkResources(dictionaries({ save: '' }, { save: 'Save' })).join('\n'), /empty translation/)
  assert.match(checkResources(dictionaries({ save: '{{name}}' }, { save: '{{title}}' })).join('\n'), /interpolation arguments differ/)
})

test('English singular and plural forms cannot silently fall back to an untranslated key', () => {
  assert.match(checkResources(dictionaries({ files_other: '{{count}} 个文件' }, { files_other: '{{count}} files' })).join('\n'), /English plural needs _one and _other/)
  assert.match(checkResources(dictionaries({ files_other: '{{count}} 个文件' }, { files_one: '{{count}} file' })).join('\n'), /English plural needs _one and _other/)
})

test('hardcoded rendered text, accessibility labels, placeholders and conditional/template text fail', () => {
  const issues = check(`function Card(){ return <><span>保存</span><input placeholder="Search" title={'Help'} aria-label={busy ? 'Saving' : 'Save'} /><img alt={\`Photo \${number}\`} /></> }`)
  for (const text of ['保存', 'Search', 'Help', 'Saving', 'Save', 'Photo']) assert.ok(issues.some((issue) => issue.includes(text)), text)
  assert.ok(issues.every((issue) => /Fixture.tsx:\d+:/.test(issue)))
})

test('literal alert/confirmation/notice messages fail, but internal state and user-authored values do not', () => {
  assert.equal(check(`function Card({content}){ const mode='night'; return <div data-mode="night" className="wide">{content.note}{count}{busy && <p>{t('common:save')}</p>}</div> }`).length, 0)
  for (const expression of ["window.confirm('Delete?')", "setNotice('Failed')", "setEditorNotice('失败')"]) {
    assert.match(check(`function Card(){ ${expression}; return null }`).join('\n'), /fixed UI text/)
  }
})

test('visible constants and text hidden in template interpolation branches cannot bypass the guard', () => {
  assert.match(check("const heading='Hardcoded heading'; function Card(){ return <h1>{heading}</h1> }").join('\n'), /Hardcoded heading/)
  assert.match(check("function Card(){ return <p>{`${busy ? '保存中' : '保存'}`}</p> }").join('\n'), /保存中/)
  assert.deepEqual(check("const note='Module value'; function Card({note}){ return <p>{note}</p> }"), [])
})

test('locally declared object copy is checked while unknown user data remains untouched', () => {
  assert.match(check("const copy={heading:'Hardcoded'}; function Card(){ return <p>{copy.heading}</p> }").join('\n'), /Hardcoded/)
  assert.match(check("function Card(){ const title='Nested fixed copy'; const copy={nested:{title}}; return <p>{copy.nested.title}</p> }").join('\n'), /Nested fixed copy/)
  assert.match(check("function Card(){ const copy={heading:'Attribute text'}; return <input placeholder={copy['heading']} /> }").join('\n'), /Attribute text/)
  assert.deepEqual(check("const copy={heading:'Outer source'}; function Card({copy}){ return <p>{copy.heading}</p> }"), [])
  assert.deepEqual(check("function Card({user}){ const copy={heading:user.note}; return <p>{copy.heading}</p> }"), [])
})

test('renamed hook translation functions and local aliases cannot bypass missing-key checks', () => {
  assert.match(check("function Card(){ const {t:translate}=useTranslation('common'); return <p>{translate('typo')}</p> }").join('\n'), /translation key missing/)
  assert.match(check("function Card(){ const {t:translate}=useUiLocale(); const render=translate; return <p>{render('typo')}</p> }").join('\n'), /translation key missing/)
  assert.deepEqual(check("function Card(){ const {t:translate}=useTranslation('common'); return <p>{translate('save')}</p> }"), [])
})

test('global i18n.t uses the configured common namespace and honors a literal ns override', () => {
  const both = { 'zh-Hans': { ...resources['zh-Hans'], details: { detailOnly: '详情' } }, en: { ...resources.en, details: { detailOnly: 'Detail' } } }
  const verify = (expression) => checkUiSource(`function Card(){ const {t}=useTranslation('details'); return <p>{${expression}}</p> }`, 'src/components/Fixture.tsx', both)
  assert.match(verify("i18n.t('detailOnly')").join('\n'), /translation key missing/)
  assert.deepEqual(verify("i18n.t('save')"), [])
  assert.deepEqual(verify("i18n.t('detailOnly',{ns:'details'})"), [])
  assert.deepEqual(verify("i18n.t('detailOnly',{ns:['details']})"), [])
  assert.match(verify("i18n.t('save',{ns:'missing'})").join('\n'), /translation key missing/)
  assert.match(verify("i18n.t('save',{ns:unknownNamespace})").join('\n'), /must be statically known/)
})

test('static translation calls and keyed notices fail when either language lacks their key', () => {
  assert.equal(check(`function Card(){ const {t}=useTranslation('common'); return <p>{t(busy?'save':'cancel')}{t('count',{count:1})}</p> }`).length, 0)
  assert.match(check(`function Card(){ const {t}=useTranslation('common'); return <p>{t('typo')}</p> }`).join('\n'), /translation key missing/)
  assert.match(check(`function Card(){ setNotice({key:'common:typo'}); editorErrorNotice(error,'common:anotherTypo') }`).join('\n'), /anotherTypo/)
  assert.match(check(`function Card(){ setNotice({key:'save'}) }`).join('\n'), /must include its namespace/)
  assert.match(check(`function Card(){ const {t}=useTranslation('common'); return <p>{i18n.t('typo')}</p> }`).join('\n'), /translation key missing/)
})

test('brand and keyboard exceptions apply only to an exact literal in an exact file with a reason', () => {
  const options = { exceptions: [{ file: 'src/components/Fixture.tsx', literal: 'StarMap', reason: 'Brand' }] }
  assert.deepEqual(check('const Card=()=> <p>StarMap</p>', options), [])
  assert.match(check('const Card=()=> <p>StarMap settings</p>', options).join('\n'), /fixed UI text/)
  assert.match(checkUiSource('const Card=()=> <p>StarMap</p>', 'src/components/Other.tsx', resources, options).join('\n'), /fixed UI text/)
})

test('unbounded dynamic translation expressions fail; finite contracts check every candidate', () => {
  const source = "function Card(){ const {t}=useTranslation('common'); return <p>{t(option.id)}</p> }"
  assert.match(check(source).join('\n'), /needs a finite contract/)
  const contract = { file: 'src/components/Fixture.tsx', expression: 'option.id', keys: ['save', 'cancel'] }
  assert.deepEqual(check(source, { contracts: [contract] }), [])
  assert.match(check(source, { contracts: [{ ...contract, keys: ['save', 'newMissingOption'] }] }).join('\n'), /newMissingOption/)
})

test('dynamic option contracts derive new registry and option keys from current declarations', () => {
  const files = new Map([
    ['src/data/mapSources.ts', "const mapSourceOptions=[{id:'local'}]"],
    ['src/extensions/mapSources.ts', "const googleOption={id:'google'}"],
    ['src/worldgraph/layers.ts', "const officialLayers=[{labelKey:'layer:travel'},{labelKey:'layer:newLayer'}]"],
    ['src/components/AtlasHeader.tsx', "const navItems=[{id:'map'},{id:'newPage'}]"],
    ['src/components/CollectionPage.tsx', "const statusOptions=[{id:'all'}]; const sortOptions=[{id:'recent'}]; runWrite(action,'newOperationFailed')"],
    ['src/components/JourneyViewToggle.tsx', "const options=[{id:'timeline'}]"],
    ['src/components/InfoCard.tsx', "const continentRules=[{continent:'North America'}]"],
    ['src/components/MouseControlGuide.tsx', "const controls=[{key:'drag',label:'orbit'}]"],
    ['src/components/PrivateDataNotice.tsx', "const lines=kind==='internal-state'?['legacy']:['empty']"],
    ['src/i18n/mediaViewerOptions.ts', "const panoramaLanguageKeys=['zoom','newThirdPartyControl'] as const"],
    ['src/components/LayerPanel.tsx', "runHiddenItemAction(action,'restoreFailed')"],
    ['src/components/DroneMediaCard.tsx', "const readErrors=[condition==='internal'?'newReadFailure':undefined].filter(Boolean); const fallback={errorKeys:['readFileError']}"],
  ])
  const contracts = dynamicKeyContracts(files)
  assert.ok(contracts.find((item) => item.file.endsWith('/AtlasHeader.tsx')).keys.includes('newPage'))
  assert.ok(contracts.find((item) => item.expression === 'layer.labelKey').keys.includes('layer:newLayer'))
  assert.ok(contracts.find((item) => item.file.endsWith('/DronePanoramaModal.tsx')).keys.includes('newThirdPartyControl'))
  assert.deepEqual(contracts.find((item) => item.file.endsWith('/PrivateDataNotice.tsx')).keys, ['legacy', 'empty'])
  assert.ok(contracts.find((item) => item.expression === '`collection:${failureKey}`').keys.includes('collection:newOperationFailed'))
  assert.deepEqual(contracts.find((item) => item.file.endsWith('/DroneMediaCard.tsx')).keys, ['newReadFailure', 'readFileError'])
  files.set('src/worldgraph/layers.ts', "const additionalLabel='layer:missing'; const officialLayers=[{labelKey:'layer:travel'},{labelKey:additionalLabel}]")
  const aliased = dynamicKeyContracts(files)
  assert.ok(aliased.find((item) => item.expression === 'layer.labelKey').keys.includes('layer:missing'))
  assert.match(checkUiSource("function Panel(){return <p>{t(layer.labelKey)}</p>}", 'src/components/LayerPanel.tsx', resources, {contracts:aliased}).join('\n'), /layer:missing/)
  files.set('src/worldgraph/layers.ts', "const officialLayers=[{labelKey:'layer:travel'},{labelKey:getUnknownKey()}]")
  assert.throws(() => dynamicKeyContracts(files), /Cannot enumerate/)
  files.set('src/worldgraph/layers.ts', "const officialLayers=[{labelKey:'layer:travel'},...runtimeLayers]")
  assert.throws(() => dynamicKeyContracts(files), /Cannot enumerate/)
})

test('live import traversal includes new and dynamically imported UI while ignoring unreferenced legacy files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'starmap-i18n-guard-'))
  assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep))
  try {
    await mkdir(path.join(root, 'src/components'), { recursive: true })
    await writeFile(path.join(root, 'src/main.tsx'), "import './components/Live'; import type {Unused} from './components/TypeOnly'; const lazy=import('./components/Lazy')")
    await writeFile(path.join(root, 'src/components/Live.tsx'), 'export const Live=()=> <p>Live</p>')
    await writeFile(path.join(root, 'src/components/Lazy.tsx'), 'export const Lazy=()=> <p>Lazy</p>')
    await writeFile(path.join(root, 'src/components/AtlasGlobe.tsx'), 'export const Legacy=()=> <p>Legacy</p>')
    await writeFile(path.join(root, 'src/components/TypeOnly.tsx'), 'export type Unused=string; const UnusedUi=()=> <p>Unused</p>')
    const files = await activeSourceFiles(root)
    assert.ok(files.has('src/components/Live.tsx'))
    assert.ok(files.has('src/components/Lazy.tsx'))
    assert.ok(!files.has('src/components/AtlasGlobe.tsx'))
    assert.ok(!files.has('src/components/TypeOnly.tsx'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
