/** Cesium's run-time files without a third-party copy plugin (batch 4B, E8): dev middleware and build copy, in temp dirs. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CESIUM_STATIC_DIRECTORIES, cesiumStatic, contentTypeOf, resolveCesiumStaticFile } from './cesium-static-plugin.mjs'

const baseUrl = 'cesium/1.0.0'
const files = { 'Workers/createGeometry.js': 'export const worker = 1\n', 'ThirdParty/draco.wasm': 'wasm bytes', 'Assets/Textures/NaturalEarthII/0/0/0.jpg': 'jpg bytes', 'Widgets/widgets.css': '.cesium {}\n' }

async function withSource(run) {
  const prefix = 'starmap-cesium-static-'
  const directory = await mkdtemp(path.join(tmpdir(), prefix))
  try {
    const sourceRoot = path.join(directory, 'Build', 'Cesium')
    for (const [name, text] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(sourceRoot, name)), { recursive: true })
      await writeFile(path.join(sourceRoot, name), text)
    }
    // Files next to and above the four directories, which must never be served or copied.
    await writeFile(path.join(sourceRoot, 'secret.txt'), 'inside the build root')
    await writeFile(path.join(directory, 'outside.txt'), 'outside the build root')
    await mkdir(path.join(sourceRoot, 'Source'))
    await writeFile(path.join(sourceRoot, 'Source', 'x.js'), 'not a run-time directory')
    await run({ directory, sourceRoot })
  } finally {
    assert.equal(path.dirname(directory), path.resolve(tmpdir()))
    assert.ok(path.basename(directory).startsWith(prefix))
    await rm(directory, { recursive: true, force: true })
  }
}

const listFiles = async (root) => (await readdir(root, { recursive: true, withFileTypes: true }))
  .filter((entry) => entry.isFile()).map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join('/')).sort()

test('every file type in the installed Cesium run-time directories has a content type', async () => {
  const buildRoot = path.join(path.dirname(fileURLToPath(new URL('../node_modules/cesium/package.json', import.meta.url))), 'Build', 'Cesium')
  for (const directory of CESIUM_STATIC_DIRECTORIES) {
    for (const name of await listFiles(path.join(buildRoot, directory))) assert.notEqual(contentTypeOf(name), 'application/octet-stream', `${directory}/${name}`)
  }
  assert.equal(contentTypeOf('a.js'), 'text/javascript')
  assert.equal(contentTypeOf('a.wasm'), 'application/wasm')
  assert.equal(contentTypeOf('A.JPG'), 'image/jpeg')
})

test('a request path resolves only to a file inside one of the four directories', () => {
  const sourceRoot = path.resolve('/x/Build/Cesium')
  assert.equal(resolveCesiumStaticFile('/cesium/1.0.0/Workers/createGeometry.js', { baseUrl, sourceRoot }), path.join(sourceRoot, 'Workers', 'createGeometry.js'))
  assert.equal(resolveCesiumStaticFile('/cesium/1.0.0/Assets/Textures/a%20b.jpg', { baseUrl, sourceRoot }), path.join(sourceRoot, 'Assets', 'Textures', 'a b.jpg'))
  for (const pathname of ['/cesium/1.0.0/Workers/..%2fsecret.txt', '/cesium/1.0.0/Workers/..%2F..%2Foutside.txt', '/cesium/1.0.0/Workers/%2e%2e/secret.txt',
    '/cesium/1.0.0/Workers/..%5csecret.txt', '/cesium/1.0.0/Workers/..%5c..%5coutside.txt', '/cesium/1.0.0/Workers/../Source/x.js', '/cesium/1.0.0/Source/x.js',
    '/cesium/1.0.0/secret.txt', '/cesium/1.0.0/workers/createGeometry.js', '/cesium/1.0.0/Workers', '/cesium/1.0.0/Workers/', '/cesium/1.0.0/Workers/a%00.js',
    '/cesium/1.0.0/Workers/%E0%A4%A', '/cesium/1.0.0/%2e%2e%2fpackage.json', '/cesium/0.9.0/Workers/createGeometry.js', '/Workers/createGeometry.js']) {
    assert.equal(resolveCesiumStaticFile(pathname, { baseUrl, sourceRoot }), null, pathname)
  }
})

test('the dev middleware serves the four directories with their content types and answers 404 for everything else under the prefix', async () => withSource(async ({ sourceRoot }) => {
  const plugin = cesiumStatic({ baseUrl, sourceRoot })
  let middleware
  plugin.configureServer({ middlewares: { use: (handler) => { middleware = handler } } })
  const server = http.createServer((request, response) => middleware(request, response, () => { response.statusCode = 418; response.end('next') }))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  // An own agent and a raw path: no proxy from the environment and no client-side normalisation of `..`.
  const agent = new http.Agent()
  const send = (requestPath, method = 'GET') => new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port: server.address().port, path: requestPath, method, agent }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk)).on('end', () => resolve({ status: response.statusCode, type: response.headers['content-type'], length: response.headers['content-length'], body: Buffer.concat(chunks).toString() }))
    })
    request.on('error', reject).end()
  })
  try {
    const types = { 'Workers/createGeometry.js': 'text/javascript', 'ThirdParty/draco.wasm': 'application/wasm', 'Assets/Textures/NaturalEarthII/0/0/0.jpg': 'image/jpeg', 'Widgets/widgets.css': 'text/css' }
    for (const [name, text] of Object.entries(files)) {
      assert.deepEqual(await send(`/${baseUrl}/${name}?v=1`), { status: 200, type: types[name], length: String(Buffer.byteLength(text)), body: text }, name)
    }
    assert.deepEqual(await send(`/${baseUrl}/Workers/createGeometry.js`, 'HEAD'), { status: 200, type: 'text/javascript', length: String(Buffer.byteLength(files['Workers/createGeometry.js'])), body: '' })
    for (const requestPath of ['/cesium/1.0.0/Workers/..%2fsecret.txt', '/cesium/1.0.0/Workers/..%2f..%2f..%2foutside.txt', '/cesium/1.0.0/Workers/%2e%2e%2fsecret.txt',
      '/cesium/1.0.0/Workers/..%5c..%5c..%5coutside.txt', '/cesium/1.0.0/Workers/../secret.txt', '/cesium/1.0.0/Source/x.js',
      '/cesium/1.0.0/Workers/', '/cesium/1.0.0/Workers/missing.js', '/cesium/1.0.0/Workers/%E0%A4%A', '/cesium/1.0.0/Workers/a%00.js']) {
      const result = await send(requestPath)
      assert.equal(result.status, 404, requestPath)
      assert.equal(result.body, '', requestPath)
    }
    // Paths outside the prefix and other methods are left to the rest of the server. A raw ../ that climbs out of the
    // prefix is already removed by URL parsing, so that request is no longer under the prefix either.
    for (const [requestPath, method] of [['/src/main.tsx', 'GET'], ['/cesium/1.0.0/Workers/../../../outside.txt', 'GET'], ['/cesium/0.9.0/Workers/createGeometry.js', 'GET'], [`/${baseUrl}/Workers/createGeometry.js`, 'POST']]) {
      assert.equal((await send(requestPath, method)).status, 418, `${method} ${requestPath}`)
    }
  } finally {
    agent.destroy()
    await new Promise((resolve) => server.close(resolve))
  }
}))

test('a build copies exactly the four directories to <root>/<outDir>/<baseUrl>; other commands copy nothing', async () => withSource(async ({ directory, sourceRoot }) => {
  const root = path.join(directory, 'project')
  const plugin = cesiumStatic({ baseUrl, sourceRoot })
  plugin.configResolved({ command: 'serve', root, build: { outDir: 'out' } })
  await plugin.writeBundle()
  assert.deepEqual((await readdir(directory)).sort(), ['Build', 'outside.txt'], 'the dev server and the preview never write')
  plugin.configResolved({ command: 'build', root, build: { outDir: 'out' } })
  await plugin.writeBundle()
  const target = path.join(root, 'out', 'cesium', '1.0.0')
  assert.deepEqual(await listFiles(target), Object.keys(files).sort())
  for (const [name, text] of Object.entries(files)) assert.equal(await readFile(path.join(target, name), 'utf8'), text, name)
  // An absolute outDir is used as it is.
  const absolute = path.join(directory, 'absolute-out')
  plugin.configResolved({ command: 'build', root, build: { outDir: absolute } })
  await plugin.writeBundle()
  assert.deepEqual(await listFiles(path.join(absolute, 'cesium', '1.0.0')), Object.keys(files).sort())
}))
