/**
 * UUIDv7（canonical/uuidv7.ts）的单元测试（RFC-LOC-1 PR3a 规格 §2.3、§4）。
 *
 * 运行方式：npm test。零依赖：Node 24 自带类型剥离，只用 node:test + node:assert/strict。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { UUID_V7_PATTERN, isUuidV7, uuidV7Timestamp, uuidv7 } from './uuidv7.ts'

const bytesOf = (value: number) => (length: number) => new Uint8Array(length).fill(value)

test('格式：小写的 8-4-4-4-12，36 个字符，默认时钟与随机源可用', () => {
  const id = uuidv7()
  assert.equal(id.length, 36)
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  assert.match(id, UUID_V7_PATTERN)
  assert.equal(isUuidV7(id), true)
})

test('版本位 0111、变体位 10：随机字节全 0 与全 1 时都成立，且不覆盖其余随机位', () => {
  const zeros = uuidv7({ now: () => 0, randomBytes: bytesOf(0x00) })
  assert.equal(zeros, '00000000-0000-7000-8000-000000000000')
  const ones = uuidv7({ now: () => 0, randomBytes: bytesOf(0xff) })
  assert.equal(ones, '00000000-0000-7fff-bfff-ffffffffffff')
  for (const id of [zeros, ones]) {
    assert.equal(id[14], '7')
    assert.ok(['8', '9', 'a', 'b'].includes(id[19]), id)
  }
})

test('注入 now：前 48 位是大端毫秒时间戳，可原样取回', () => {
  const id = uuidv7({ now: () => 0x0123456789ab, randomBytes: bytesOf(0) })
  assert.equal(id.slice(0, 13), '01234567-89ab')
  assert.equal(uuidV7Timestamp(id), 0x0123456789ab)

  const now = Date.UTC(2026, 8, 26, 12, 0, 0, 123)
  assert.equal(uuidV7Timestamp(uuidv7({ now: () => now })), now)
  assert.equal(uuidV7Timestamp(uuidv7({ now: () => 2 ** 48 - 1 })), 2 ** 48 - 1)
})

test('随机字节按顺序落在 rand_a / rand_b：只有版本与变体的 6 位被覆盖', () => {
  const random = Uint8Array.from([0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0, 0x11, 0x22])
  const id = uuidv7({ now: () => 1, randomBytes: () => random })
  assert.equal(id, '00000000-0001-7234-9678-9abcdef01122')
})

test('跨毫秒有序：时间戳递增时字符串按字典序递增，与随机部分无关', () => {
  let random = 0xff
  const ids = Array.from({ length: 200 }, (_, index) => uuidv7({
    now: () => 1_700_000_000_000 + index,
    // 随机部分故意递减，证明顺序只由时间戳决定。
    randomBytes: bytesOf(random--),
  }))
  assert.deepEqual([...ids].sort(), ids)
})

test('一万个默认生成的 id 互不相同，且都是合法的 UUIDv7', () => {
  const ids = new Set<string>()
  for (let index = 0; index < 10_000; index += 1) ids.add(uuidv7())
  assert.equal(ids.size, 10_000)
  assert.ok([...ids].every(isUuidV7))
})

test('参数错误：时间戳不是 [0, 2^48) 内的整数、随机字节不足 10 个时抛 RangeError', () => {
  for (const now of [-1, 1.5, 2 ** 48, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => uuidv7({ now: () => now }), RangeError, String(now))
  }
  assert.throws(() => uuidv7({ randomBytes: () => new Uint8Array(9) }), RangeError)
})

test('isUuidV7：只接受小写、版本 7、变体 10 的 UUID', () => {
  const valid = uuidv7({ now: () => 42, randomBytes: bytesOf(0x5a) })
  assert.equal(isUuidV7(valid), true)
  assert.equal(isUuidV7(valid.toUpperCase()), false)
  assert.equal(isUuidV7('0190a0b2-3c4d-4e5f-8a6b-7c8d9e0f1a2b'), false) // v4
  assert.equal(isUuidV7('0190a0b2-3c4d-7e5f-ca6b-7c8d9e0f1a2b'), false) // 变体 110
  assert.equal(isUuidV7(`${valid}0`), false)
  assert.equal(isUuidV7('iceland__reykjavik'), false)
  assert.equal(isUuidV7(undefined), false)
  assert.equal(isUuidV7(42), false)
})
