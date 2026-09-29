/**
 * V2 格式测试（RFC-LOC-1 PR3a）共用的小工具。不是测试文件，App 代码从不 import 它。
 *
 * - `sequentialUuids()`：确定的 UUIDv7 序列（时间戳与随机字节都由计数器给出），测试结果可逐字节复现。
 *
 * PR5b 删除了 `toV2Space()`（Legacy Adapter 的输出 → V2 id 空间）：它产出的测试数据已冻结在 `./fixtures/`（./frozen.fixture.ts）。
 */

import { uuidv7 } from './uuidv7.ts'

/** 2026-01-01T00:00:00.000Z */
export const FIXTURE_EPOCH_MS = Date.UTC(2026, 0, 1)

/** 确定的 UUIDv7 序列：第 n 个 id 的时间戳为 `startMs + n`，随机字节为 n 的大端表示。 */
export const sequentialUuids = (startMs: number = FIXTURE_EPOCH_MS): (() => string) => {
  let counter = 0
  return () => {
    counter += 1
    const n = counter
    return uuidv7({
      now: () => startMs + n,
      randomBytes: (length) => {
        const bytes = new Uint8Array(length)
        let rest = n
        for (let index = length - 1; index >= 0 && rest > 0; index -= 1) {
          bytes[index] = rest % 256
          rest = Math.floor(rest / 256)
        }
        return bytes
      },
    })
  }
}
