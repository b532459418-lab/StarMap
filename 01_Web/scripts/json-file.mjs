/**
 * 本地编辑器的公共 JSON 文件 IO。
 *
 * 这三个函数原先住在 local-editor-plugin.mjs 里。提取到这里只是为了让
 * want-to-go-store.mjs 能复用同一套「备份 + 原子改名」写入行为，
 * 而不必 import 插件（插件 import 了 sharp / undici / world-countries，
 * 且在模块顶层解析私有资料层路径，单测里不该被牵进来）。
 *
 * 行为与提取前一字不差：写入前把旧文件复制成 `.bak`，内容先写
 * `.<pid>.tmp` 再 rename，保证读方永远看到完整 JSON。
 */

import { access, copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

export const exists = async (target) => access(target).then(() => true, () => false)

export const readJson = async (target, fallback) => {
  try {
    return JSON.parse(await readFile(target, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback
    throw error
  }
}

export const atomicJsonWrite = async (target, value) => {
  await mkdir(path.dirname(target), { recursive: true })
  if (await exists(target)) await copyFile(target, target.replace(/\.json$/i, '.bak'))
  const temporaryPath = `${target}.${process.pid}.tmp`
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(temporaryPath, target)
}
