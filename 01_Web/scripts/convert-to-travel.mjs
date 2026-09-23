/**
 * 想去 → 足迹转换的纯函数（StarMap V0.4 PR9，PRD S5 / R13）。
 *
 * 为什么单独成文件：理由同 want-to-go-store.mjs —— 插件在模块顶层 import sharp / undici /
 * world-countries 并解析私有资料层路径，无法在 node --test 下直接加载。这里只放判断与构造，
 * 不 import 插件、不做任何 IO、不读时钟；所需数据全部由端点以参数传入，
 * 于是 convert-to-travel.test.mjs 可以直接覆盖每一条规则。
 *
 * 错误信息用中文，会原样出现在 `{ ok: false, error }` 里并由转换对话框直接展示。
 */

const datePattern = /^\d{4}-\d{2}-\d{2}$/

const normalizeCountryCode = (value) => (typeof value === 'string' ? value.trim().toUpperCase() : '')

const nonEmptyText = (value) => (typeof value === 'string' ? value.trim() : '')

const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value)

/**
 * 到访日期必填、结束日期可选，格式都是 YYYY-MM-DD，结束不能早于开始。
 * 文案与插件 addTravelRecord 的同名校验一致；这里先查一遍，保证在任何写入之前失败。
 */
const normalizeVisitDates = (startDate, endDate) => {
  const start = nonEmptyText(startDate)
  if (!start) throw new Error('请填写到访日期。')
  if (!datePattern.test(start)) throw new Error('到访日期必须使用 YYYY-MM-DD。')
  const end = nonEmptyText(endDate)
  if (end && !datePattern.test(end)) throw new Error('结束日期必须使用 YYYY-MM-DD。')
  if (end && end < start) throw new Error('结束日期不能早于到访日期。')
  return { start, end: end || undefined }
}

/**
 * 按国家代码确定新足迹记录的国家名（PR9 规格 §2 第 5 条）。
 *
 * 新记录的 `country_en` 决定它归到哪个国家（countryId = slug(country_en)），
 * 所以必须与已有足迹写法一致，否则同一个国家会被拆成两个。优先级：
 *
 * 1. 旅行记录里 `country_code`（不分大小写）等于该代码的第一条记录；
 * 2. `display.countryCodes` 里映射到该代码的英文国名，且有记录使用这个 `country_en`；
 * 3. 编辑状态 `addedCountries` 里 `countryCode` 等于该代码的国家；
 * 4. 国家目录（插件的 countryCatalogByCode，键为大写代码）。
 *
 * 记录缺 `country_en` 时按插件 countryIdForRecord 的口径回落到 `country`，反之亦然，
 * 保证新记录算出的 countryId 与那条记录相同。
 */
export function resolveTravelCountry(countryCode, {
  records = [],
  countryCodes = {},
  addedCountries = [],
  catalogByCode,
} = {}) {
  const code = normalizeCountryCode(countryCode)
  const travelRecords = Array.isArray(records) ? records : []
  const found = (country, countryEn) => ({ country, country_en: countryEn, country_code: code })

  if (/^[A-Z]{2}$/.test(code)) {
    for (const record of travelRecords) {
      if (normalizeCountryCode(record?.country_code) !== code) continue
      const countryEn = nonEmptyText(record.country_en) || nonEmptyText(record.country)
      if (countryEn) return found(nonEmptyText(record.country) || countryEn, countryEn)
    }

    const mappedNames = Object.entries(countryCodes && typeof countryCodes === 'object' ? countryCodes : {})
      .filter(([, mappedCode]) => normalizeCountryCode(mappedCode) === code)
      .map(([name]) => name)
    for (const name of mappedNames) {
      const record = travelRecords.find((candidate) => candidate?.country_en === name)
      if (record) return found(nonEmptyText(record.country) || name, name)
    }

    const added = (Array.isArray(addedCountries) ? addedCountries : [])
      .find((country) => normalizeCountryCode(country?.countryCode) === code)
    if (added && nonEmptyText(added.nameEn)) {
      return found(nonEmptyText(added.nameZh) || added.nameEn, added.nameEn)
    }

    const catalogEntry = catalogByCode?.get?.(code)
    if (catalogEntry && nonEmptyText(catalogEntry.nameEn)) {
      return found(nonEmptyText(catalogEntry.nameZh) || catalogEntry.nameEn, catalogEntry.nameEn)
    }
  }

  throw new Error('无法确定这个国家在足迹中的名称。')
}

/**
 * 把一条想去条目变成 addTravelRecord 接受的输入（PR9 规格 §3.1）。
 *
 * - 只接受有坐标、未隐藏的城市条目；整个国家需要先具体到城市。
 * - 想去备注【不】进旅行记录：记录的 notes 会被当作城市 memory 并把那天标成 highlight
 *   （travelAtlas.ts），"为什么想去"不是回忆（规格 §2 第 4 条）。
 * - 日期由用户明确填写，这里只校验，不补默认值。
 * - 行程标题留空时不写 trip_title，交给 addTravelRecord 的默认值「国家 · 城市」。
 */
export function buildTravelRecordInput(item, { country, startDate, endDate, tripTitle } = {}) {
  const place = item?.place ?? {}
  if (place.kind !== 'city') throw new Error('整个国家的想去需要先具体到城市，暂不支持直接转为足迹。')
  if (!isFiniteNumber(place.lat) || !isFiniteNumber(place.lng)) throw new Error('这个地点没有坐标，无法转为足迹。')
  if (item.hidden === true) throw new Error('已隐藏的想去条目不能转为足迹。')

  const dates = normalizeVisitDates(startDate, endDate)
  const cityEn = nonEmptyText(place.nameEn)
  const title = nonEmptyText(tripTitle)

  return {
    country: country.country,
    country_en: country.country_en,
    country_code: country.country_code,
    city: nonEmptyText(place.nameZh) || cityEn,
    city_en: cityEn,
    start_date: dates.start,
    ...(dates.end ? { end_date: dates.end } : {}),
    lat: place.lat,
    lng: place.lng,
    ...(title ? { trip_title: title } : {}),
  }
}

/**
 * 把一条 planned 旅行计划改为已去过（PR9 规格 §2 第 2 条）。不新增记录。
 *
 * 只改 status / start_date / end_date / year：结束日期没填时删除该键，
 * year 取到访日期的年份；其它字段原样保留。返回新的 travelMap 与被改的记录，不修改输入。
 */
export function convertPlannedRecord(travelMap, recordId, { startDate, endDate } = {}) {
  const records = Array.isArray(travelMap?.records) ? travelMap.records : []
  const index = records.findIndex((record) => record?.id === recordId)
  if (index < 0 || records[index].status !== 'planned') throw new Error('找不到这条旅行计划。')

  const current = records[index]
  if (!isFiniteNumber(current.lat) || !isFiniteNumber(current.lng)) {
    throw new Error('这条旅行计划没有坐标，无法转为足迹。')
  }

  const dates = normalizeVisitDates(startDate, endDate)
  const record = {
    ...current,
    status: 'visited',
    start_date: dates.start,
    end_date: dates.end,
    year: Number(dates.start.slice(0, 4)),
  }
  if (!dates.end) delete record.end_date

  const nextRecords = [...records]
  nextRecords[index] = record
  return { travelMap: { ...travelMap, records: nextRecords }, record }
}
