/**
 * 大洲（data/continents.ts，审查 C5）的单元测试。
 *
 * 运行方式：npm test。零依赖：Node 24 自带类型剥离，只用 node:test + node:assert/strict。
 * world-countries 只在这里用来核对表（客户端不引入它）。
 */

/// <reference types="node" />

import { test } from 'node:test'
import assert from 'node:assert/strict'

import worldCountries from 'world-countries'

import { CONTINENTS, continentOfCountry, continentOfCountryCode, type Continent } from './continents.ts'

/** 生成表时用的规则（见 ./continents.ts 文件头）。 */
const expectedContinent = ({ region, subregion }: { region: string; subregion: string }): Continent => {
  if (region === 'Americas') return subregion === 'South America' ? 'South America' : 'North America'
  if (region === 'Antarctic') return 'Antarctica'
  return region as Continent
}

test('world-countries 里每个有 cca2 的国家 / 地区都查得到大洲，且与 region / subregion 的规则一致', () => {
  const withCode = worldCountries.filter((country) => country.cca2)
  assert.equal(withCode.length, 250)
  for (const country of withCode) {
    assert.equal(continentOfCountryCode(country.cca2), expectedContinent(country), country.cca2)
  }
  const americas = withCode.filter((country) => country.region === 'Americas')
  const antarctic = withCode.filter((country) => country.region === 'Antarctic')
  assert.equal(americas.length, 56)
  assert.equal(antarctic.length, 5)
  for (const country of [...americas, ...antarctic]) assert.notEqual(continentOfCountryCode(country.cca2), undefined, country.cca2)
})

test('表里只有 CONTINENTS 列出的大洲，每个大洲都至少有一个代码', () => {
  const used = new Set(worldCountries.map((country) => continentOfCountryCode(country.cca2)))
  assert.deepEqual([...used].sort(), [...CONTINENTS].sort())
})

test('抽查：北美、南美、南极与其余四个大洲', () => {
  const cases: [string, Continent][] = [
    ['US', 'North America'], ['CA', 'North America'], ['MX', 'North America'], ['PA', 'North America'],
    ['JM', 'North America'], ['GL', 'North America'],
    ['BR', 'South America'], ['AR', 'South America'],
    ['AQ', 'Antarctica'],
    ['JP', 'Asia'], ['FR', 'Europe'], ['EG', 'Africa'], ['AU', 'Oceania'],
  ]
  for (const [code, continent] of cases) {
    assert.equal(continentOfCountryCode(code), continent, code)
    assert.equal(continentOfCountryCode(code.toLowerCase()), continent, `${code}（小写）`)
  }
  assert.equal(continentOfCountryCode('ZZ'), undefined)
  assert.equal(continentOfCountryCode(''), undefined)
  assert.equal(continentOfCountryCode(undefined), undefined)
})

test('continentOfCountry：先按国家代码查表，查不到才按关键词与记录的地区名推断', () => {
  // 格陵兰：目录给的地区是 Americas，原来的规则认不出，显示「—」；按代码是北美洲。
  assert.equal(continentOfCountry({ flagCode: 'gl', keywords: ['Americas'], records: [] }), 'North America')
  // 代码优先于关键词。
  assert.equal(continentOfCountry({ flagCode: 'is', keywords: ['Asia'] }), 'Europe')
  // 没有代码或代码不认识：回退到原来的推断。
  assert.equal(continentOfCountry({ keywords: ['北欧'] }), 'Europe')
  assert.equal(continentOfCountry({ flagCode: 'zz', keywords: [], records: [{ id: 'r', country: '', country_en: '', city: '', city_en: '', start_date: '2025', lat: null, lng: null, region: 'South America' }] }), 'South America')
  assert.equal(continentOfCountry({ flagCode: '', keywords: ['Americas'] }), undefined)
  assert.equal(continentOfCountry(undefined), undefined)
})
