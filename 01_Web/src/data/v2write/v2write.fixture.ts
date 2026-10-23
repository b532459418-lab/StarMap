/**
 * V2 写入（RFC-LOC-1 PR3b-2）测试共用的数据与调用方式。不是测试文件，App 代码从不 import 它。3C-5 E：共用的数据移到
 * ../editor/editor.fixture.ts，这里只留 V2 写入函数的测试才用的两个辅助。
 */

import type { V2FileKey, V2Files } from '../canonical/v2Schema.ts'
import { jsonClone } from '../canonical/v2Serializer.ts'
import type { V2Write } from './transaction.ts'

export * from '../editor/editor.fixture.ts'

/** 把写入应用到文件上（模拟插件按顺序写盘）。 */
export const applyWrites = (files: Partial<V2Files>, writes: readonly V2Write[]): V2Files => {
  const next = jsonClone(files) as Record<V2FileKey, unknown>
  for (const write of writes) next[write.file] = jsonClone(write.value)
  return next as unknown as V2Files
}

/** 写入顺序：只看文件名。 */
export const writeOrder = (writes: readonly V2Write[]): V2FileKey[] => writes.map((write) => write.file)
