// Cesium's run-time files (batch 4B, E8): Workers, ThirdParty, Assets and Widgets from node_modules/cesium/Build/Cesium,
// served by the dev server and copied into a build at `/<baseUrl>/<directory>/...` (vite.config.ts sets CESIUM_BASE_URL
// to the same path). Node built-ins only, so the project needs no copy plugin and none of its dependencies.
import { createReadStream } from 'node:fs'
import { cp, stat } from 'node:fs/promises'
import path from 'node:path'

export const CESIUM_STATIC_DIRECTORIES = Object.freeze(['Workers', 'ThirdParty', 'Assets', 'Widgets'])
// Every extension in those directories (Cesium 1.145); anything else is served as bytes.
const CONTENT_TYPES = { '.js': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.css': 'text/css',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.xml': 'text/xml' }
export const contentTypeOf = (file) => CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream'

/** The file a request path names inside one of the four directories, or null (other paths, traversal, bad encoding). */
export function resolveCesiumStaticFile(pathname, { baseUrl, sourceRoot }) {
  const prefix = `/${baseUrl}/`
  if (!pathname.startsWith(prefix)) return null
  let relative
  try { relative = decodeURIComponent(pathname.slice(prefix.length)) } catch { return null }
  const directory = relative.split('/')[0]
  // A backslash separates paths on Windows only, so refuse it outright: the same request then gets the same answer on
  // every platform (Cesium's run-time paths never contain one).
  if (relative.includes('\0') || relative.includes('\\') || !CESIUM_STATIC_DIRECTORIES.includes(directory)) return null
  // `..`, an encoded `/` or `\` and similar tricks all end up outside the named directory after resolving.
  const allowed = path.resolve(sourceRoot, directory)
  const file = path.resolve(sourceRoot, relative)
  return file.startsWith(allowed + path.sep) ? file : null
}

export function cesiumStatic({ baseUrl, sourceRoot }) {
  let config
  return {
    name: 'starmap-cesium-static',
    configResolved(resolved) { config = resolved },
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const { pathname } = new URL(request.url ?? '/', 'http://localhost')
        if (!pathname.startsWith(`/${baseUrl}/`) || !['GET', 'HEAD'].includes(request.method)) return next()
        const file = resolveCesiumStaticFile(pathname, { baseUrl, sourceRoot })
        const info = file && await stat(file).catch(() => null)
        if (!info?.isFile()) {
          response.statusCode = 404
          return response.end()
        }
        response.setHeader('Content-Type', contentTypeOf(file))
        response.setHeader('Content-Length', info.size)
        if (request.method === 'HEAD') return response.end()
        createReadStream(file).on('error', () => response.destroy()).pipe(response)
      })
    },
    async writeBundle() {
      if (config?.command !== 'build') return
      const target = path.resolve(config.root, config.build.outDir, baseUrl)
      for (const directory of CESIUM_STATIC_DIRECTORIES) {
        await cp(path.join(sourceRoot, directory), path.join(target, directory), { recursive: true, force: true })
      }
    },
  }
}
