/**
 * 本地编辑器的公共 JSON 文件 IO。
 *
 * 这三个函数原先住在 local-editor-plugin.mjs 里。提取到这里是为了让
 * 插件之外的脚本（V2 写入层、导入器、迁移工具）复用同一套「备份 + 原子改名」写入行为，
 * 而不必 import 插件（插件 import 了 sharp / undici / world-countries，
 * 且在模块顶层解析私有资料层路径，单测里不该被牵进来）。
 *
 * 写入顺序：写入前把旧文件复制成 `.bak`（只保留一代，行为不变）；内容写进同目录下带随机后缀的临时文件
 * `<目标>.<pid>.<uuid>.tmp`（`wx` 创建，绝不复用或覆盖别人的临时文件），fsync 后关闭，再 rename 到目标，
 * 最后对父目录 fsync（Windows 不支持目录 fsync，这一步的错误忽略）。任何一步失败都删除临时文件再抛出，
 * 所以读方永远只看到旧的或新的完整 JSON，目录里也不会留下临时文件。
 */

import { randomUUID } from 'node:crypto'
import { access, copyFile, mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
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

/** 父目录 fsync：让 rename 本身落盘。Windows 打不开目录句柄（EISDIR / EPERM），忽略。 */
const syncDirectory = async (directory) => {
  let handle
  try {
    handle = await open(directory, 'r')
    await handle.sync()
  } catch {
    // 不支持目录 fsync 的平台：rename 已经完成，数据文件本身已 fsync。
  } finally {
    await handle?.close().catch(() => {})
  }
}

export const atomicJsonWrite = async (target, value) => {
  const content = `${JSON.stringify(value, null, 2)}\n`
  await mkdir(path.dirname(target), { recursive: true })
  if (await exists(target)) await copyFile(target, target.replace(/\.json$/i, '.bak'))
  const temporaryPath = `${target}.${process.pid}.${randomUUID()}.tmp`
  let handle
  let created = false
  try {
    handle = await open(temporaryPath, 'wx')
    created = true
    await handle.writeFile(content, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temporaryPath, target)
  } catch (error) {
    await handle?.close().catch(() => {})
    if (created) await unlink(temporaryPath).catch(() => {})
    throw error
  }
  await syncDirectory(path.dirname(target))
}
