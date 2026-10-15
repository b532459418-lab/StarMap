/**
 * 私人数据可以写到哪里（隐私门）。基线工具 `baseline.mjs` 用这一个判断（PR5b 删除的迁移工具也曾用它）。
 *
 * 规则：
 * - 目标位于解析出的私人根目录（`resolvePrivateRoot()`，即 `getPrivatePaths().root`）之内：放行，
 *   即使私人根在仓库里——独立克隆默认用仓库内的 `06_private/`，它由 `.gitignore` 覆盖；
 * - 否则必须在本 Git 仓库之外。
 *
 * 例外：私人根就是仓库根、或包含整个仓库时，不给「私人根之内」这项放行，否则整个仓库都算在内。
 *
 * 判断前先规范化路径：最深的已存在祖先取真实路径（解开符号链接、目录联接与大小写），再接上不存在的部分。
 */

import { existsSync, realpathSync } from 'node:fs'
import path from 'node:path'

import { isPathInside, mayBeInside } from './path-containment.mjs'
import { resolvePrivateRoot, sourceRoot } from './private-profile.mjs'

/** 最深的已存在祖先取真实路径，再接上不存在的部分。 */
export const canonicalPath = (target) => {
  let existing = path.resolve(target)
  const missing = []
  while (!existsSync(existing)) {
    const parent = path.dirname(existing)
    if (parent === existing) break
    missing.unshift(path.basename(existing))
    existing = parent
  }
  try {
    return path.join(realpathSync.native(existing), ...missing)
  } catch {
    return path.resolve(target)
  }
}

/**
 * 放行类判断：`target` 是 `directory` 本身或确定在它之内才为真（两边都先规范化，再按 ./path-containment.mjs 的
 * `isPathInside`）。以 `..` 开头的名字（`..x`、`.. `、`...`）算在外面。
 */
export const isInsideDirectory = (target, directory) =>
  isPathInside(canonicalPath(directory), canonicalPath(target), { allowRoot: true })

/**
 * 拒绝类判断：`target` 是 `directory` 本身或【可能】在它之内就为真（规范化之后按 `mayBeInside`）。以 `..` 开头的名字
 * 算在里面；只有 `..` 本身、`..` 加分隔符开头、或绝对路径才算外面。
 */
export const mayBeInsideDirectory = (target, directory) =>
  mayBeInside(canonicalPath(directory), canonicalPath(target), { allowRoot: true })

/** 仓库根就是 private-profile.mjs 的 sourceRoot（01_Web 的上一级，Git 的根）。拒绝类：可能在仓库里就算在里面。 */
export const isInsideRepository = (target) => mayBeInsideDirectory(target, sourceRoot)

/** 私人数据（基线、迁移结果、报告）可以写到 `target` 吗？规则见文件头。 */
export const isAllowedPrivateOutput = (target, environment = process.env) => {
  const privateRoot = resolvePrivateRoot(environment)
  // 拒绝类：私人根可能包含整个仓库时，不给「私人根之内」的放行。放行类：目标确定在私人根之内才放行。
  const privateRootCoversRepository = mayBeInsideDirectory(sourceRoot, privateRoot)
  if (!privateRootCoversRepository && isInsideDirectory(target, privateRoot)) return true
  return !isInsideRepository(target)
}
