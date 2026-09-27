/**
 * countrySearchFilter（新增国家的目录候选去掉已在列表里的国家）的单元测试（RFC-LOC-1 PR3b-2 审查补修）。
 *
 * 运行方式：npm test。零依赖：Node 24 自带类型剥离，只用 node:test + node:assert/strict。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { isCountryAlreadyListed, withoutListedCountries } from './countrySearchFilter.ts'

/** 目录候选：id 是英文名的 slug，countryCode 是大写 ISO（同插件的 searchCountryCatalog）。 */
const option = (id: string, countryCode?: string) => ({ id, nameZh: id, nameEn: id, ...(countryCode !== undefined ? { countryCode } : {}) })

const ICELAND_UUID = '019b76da-a801-7000-8000-000000000001'

test('V2：国家列表的 id 是地点 UUID、与目录的 slug 不同，但国家代码相同 → 过滤', () => {
  const countries = [{ id: ICELAND_UUID, flagCode: 'is' }]
  assert.equal(isCountryAlreadyListed(option('iceland', 'IS'), countries), true)
  assert.deepEqual(withoutListedCountries([option('iceland', 'IS'), option('japan', 'JP')], countries).map((item) => item.id), ['japan'])
})

test('旧模式：国家列表的 id 就是目录的 slug → 过滤（与原来的结果相同）', () => {
  const countries = [{ id: 'iceland', flagCode: 'is' }, { id: 'faroe-islands', flagCode: 'fo' }]
  assert.equal(isCountryAlreadyListed(option('iceland', 'IS'), countries), true)
  assert.equal(isCountryAlreadyListed(option('faroe-islands', 'FO'), countries), true)
  assert.equal(isCountryAlreadyListed(option('iceland'), countries), true, '候选没有代码时仍按 id 过滤')
})

test('国家代码大小写不同、带空白 → 仍按同一代码过滤', () => {
  assert.equal(isCountryAlreadyListed(option('japan', 'JP'), [{ id: 'x', flagCode: 'jp' }]), true)
  assert.equal(isCountryAlreadyListed(option('japan', 'jp'), [{ id: 'x', flagCode: 'JP' }]), true)
  assert.equal(isCountryAlreadyListed(option('japan', ' jp '), [{ id: 'x', flagCode: 'Jp' }]), true)
})

test('没有国家代码的国家只按 id 比较：id 不同就保留，id 相同就过滤', () => {
  const countries = [{ id: ICELAND_UUID }, { id: 'norway', flagCode: '' }]
  assert.equal(isCountryAlreadyListed(option('iceland', 'IS'), countries), false)
  assert.equal(isCountryAlreadyListed(option('norway', 'NO'), countries), true)
  assert.equal(isCountryAlreadyListed(option(ICELAND_UUID, 'IS'), countries), true)
  // 候选也没有代码时，空代码不会互相匹配。
  assert.equal(isCountryAlreadyListed(option('nowhere'), [{ id: 'elsewhere' }]), false)
})

test('不相关的国家保留，原顺序不变；国家列表为空时全部保留', () => {
  const options = [option('japan', 'JP'), option('iceland', 'IS'), option('denmark', 'DK')]
  const countries = [{ id: ICELAND_UUID, flagCode: 'is' }]
  assert.deepEqual(withoutListedCountries(options, countries).map((item) => item.id), ['japan', 'denmark'])
  assert.deepEqual(withoutListedCountries(options, []), options)
  // 返回原来的对象（组件拿它作候选），不复制。
  assert.equal(withoutListedCountries(options, countries)[0], options[0])
})
