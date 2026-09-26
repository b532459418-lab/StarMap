/**
 * UUIDv7（RFC 9562 §5.7；RFC-LOC-1 ID-3，PR3a 规格 §2.3）。
 *
 * `src/data/canonical/` 是 App 层，【不是】 StarMap Core。Core 只接收 id、不铸造 id（ID-3）：
 * 地点 id 由写入层生成——今天是迁移工具，PR3b 起是 Node 写入端点，将来是 App 自己。
 * 所以放在这里而不是 `scripts/`：Node 与浏览器都能用（`crypto.getRandomValues` 两边都有）。
 *
 * 布局（128 位，大端）：
 *   unix_ts_ms 48 位 | ver 4 位 = 0111 | rand_a 12 位 | var 2 位 = 10 | rand_b 62 位
 * 输出为小写的 8-4-4-4-12 形式。不要求同一毫秒内单调（RFC 9562 §6.2 的计数器方案都不采用）：
 * 同一毫秒内的两个 id 顺序随机，跨毫秒按时间有序。
 *
 * 不加依赖。时钟与随机源都可注入，测试因此是确定的。
 *
 * 约束：Node 24 能直接加载——erasable-only TypeScript。
 */

export interface UuidV7Options {
  /** 当前时间的 Unix 毫秒数。默认 `Date.now`。 */
  now?: () => number
  /** 返回 `length` 个随机字节。默认 `crypto.getRandomValues`。 */
  randomBytes?: (length: number) => Uint8Array
}

/** 48 位时间戳的上限（不含）。 */
const TIMESTAMP_LIMIT = 2 ** 48

/** 随机部分需要的字节数：rand_a 与 rand_b 共 74 位，连同被版本位与变体位覆盖的 6 位，正好 10 字节。 */
const RANDOM_BYTES = 10

const defaultRandomBytes = (length: number): Uint8Array => crypto.getRandomValues(new Uint8Array(length))

const hex = (bytes: Uint8Array, start: number, end: number): string => {
  let text = ''
  for (let index = start; index < end; index += 1) text += bytes[index].toString(16).padStart(2, '0')
  return text
}

/** 生成一个 UUIDv7。时间戳不是 [0, 2^48) 内的整数、或随机源给的字节不够时抛 RangeError。 */
export function uuidv7(options: UuidV7Options = {}): string {
  const timestamp = (options.now ?? Date.now)()
  if (!Number.isInteger(timestamp) || timestamp < 0 || timestamp >= TIMESTAMP_LIMIT) {
    throw new RangeError('uuidv7：时间戳必须是 0 到 2^48 - 1 之间的整数毫秒数。')
  }
  const random = (options.randomBytes ?? defaultRandomBytes)(RANDOM_BYTES)
  if (!(random instanceof Uint8Array) || random.length < RANDOM_BYTES) {
    throw new RangeError(`uuidv7：随机源至少要给 ${RANDOM_BYTES} 个字节。`)
  }

  const bytes = new Uint8Array(16)
  // 48 位时间戳，大端。2^48 超过 32 位整数，不能用位运算，按 256 逐字节取余。
  let rest = timestamp
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = rest % 256
    rest = Math.floor(rest / 256)
  }
  bytes.set(random.subarray(0, RANDOM_BYTES), 6)
  bytes[6] = 0x70 | (bytes[6] & 0x0f) // 版本 7
  bytes[8] = 0x80 | (bytes[8] & 0x3f) // 变体 10

  return `${hex(bytes, 0, 4)}-${hex(bytes, 4, 6)}-${hex(bytes, 6, 8)}-${hex(bytes, 8, 10)}-${hex(bytes, 10, 16)}`
}

/** 小写的 UUIDv7 字符串（版本位 7、变体位 10）。StarMap 只写小写，大写视为不是。 */
export const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export const isUuidV7 = (value: unknown): value is string =>
  typeof value === 'string' && UUID_V7_PATTERN.test(value)

/** 从 UUIDv7 里取回毫秒时间戳（只用于测试与诊断；代码不得据此判断任何身份，RFC ID-1）。 */
export const uuidV7Timestamp = (value: string): number => Number.parseInt(value.slice(0, 8) + value.slice(9, 13), 16)
