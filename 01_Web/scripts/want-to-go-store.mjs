/**
 * Want to Go 存储层（PRD FR-WTG-2 / FR-WTG-5 / FR-WTG-6 / FR-WTG-8）。
 *
 * 为什么单独成文件、而不是写在 local-editor-plugin.mjs 里：
 * 插件在模块顶层 import sharp / undici / world-countries 并解析私有资料层路径，
 * 无法在 node --test 下直接加载。把「读—改—原子写」与全部校验放在这里，
 * 端点只剩转发，校验就有了 want-to-go-store.test.mjs 这一层真实覆盖。
 *
 * 纪律：
 * - 所有写入都经过 json-file.mjs 的 atomicJsonWrite，保留 `.bak` 备份与原子改名。
 * - 时间由 `now` 注入，测试可以钉死；本文件不直接调用 new Date()。
 * - 错误信息用中文，风格与插件里的 requireText / numberInRange 对齐，
 *   因为它们会原样出现在 `{ ok: false, error }` 里并被 UI 直接展示。
 */

import { atomicJsonWrite, readJson } from './json-file.mjs'

/**
 * 与 local-editor-plugin.mjs 的 slugify 规则完全一致（小写、NFKC、
 * 非字母数字折叠成 `-`、去首尾 `-`）。这里复制一份而不是 import 插件，
 * 理由见文件头。改动其中一处时必须同步另一处。
 */
const slugify = (value) => value
  .toLowerCase()
  .normalize('NFKC')
  .trim()
  .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
  .replace(/^-|-$/g, '')

const requireText = (value, label) => {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) throw new Error(`请填写${label}。`)
  return text
}

const numberInRange = (value, min, max, label) => {
  const number = Number(value)
  if (!Number.isFinite(number) || number < min || number > max) throw new Error(`${label}无效。`)
  return number
}

const datePattern = /^\d{4}-\d{2}-\d{2}$/

/** 本地日期而不是 UTC 日期：加入日期是给人看的，跨时区对齐没有意义。 */
const localDate = (date) => {
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

const emptyFile = (generatedAt) => ({
  schema_version: 1,
  generated_at: generatedAt,
  privacy_level: 'local-only',
  items: [],
})

/** 去重键（FR-WTG-8）：国家代码 + 英文名 slug，大小写与标点差异都不算新地点。 */
const placeKey = (countryCode, nameEn) => `${String(countryCode).toUpperCase()}:${slugify(String(nameEn))}`

const itemPlaceKey = (item) => placeKey(item?.place?.countryCode ?? '', item?.place?.nameEn ?? '')

/** 备注：trim 后 ≤ 200 字；空串表示"没有备注"，由调用方决定是写入还是删除。 */
const normalizeNote = (value) => {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error('备注必须是文本。')
  const note = value.trim()
  if (note.length > 200) throw new Error('备注最多 200 字。')
  return note
}

const normalizePlace = (value) => {
  const place = value && typeof value === 'object' ? value : {}
  if (place.kind !== 'city' && place.kind !== 'country') {
    throw new Error('想去条目的类型只能是 city 或 country。')
  }
  const nameEn = requireText(place.nameEn, '地点英文名')
  const nameZh = typeof place.nameZh === 'string' && place.nameZh.trim() ? place.nameZh.trim() : nameEn
  const countryCode = requireText(place.countryCode, '国家代码').toUpperCase()
  if (!/^[A-Z]{2}$/.test(countryCode)) throw new Error('国家代码必须是两个英文字母。')

  const hasLat = place.lat !== undefined && place.lat !== null && place.lat !== ''
  const hasLng = place.lng !== undefined && place.lng !== null && place.lng !== ''
  if (hasLat !== hasLng) throw new Error('经纬度需要同时填写，或同时留空。')

  // D06：没有坐标的 Entity 是合法的，所以这里不强制要求坐标。
  return {
    kind: place.kind,
    nameZh,
    nameEn,
    countryCode,
    ...(hasLat
      ? {
          lat: numberInRange(place.lat, -90, 90, '纬度'),
          lng: numberInRange(place.lng, -180, 180, '经度'),
        }
      : {}),
  }
}

export function createWantToGoStore({ filePath, now = () => new Date() }) {
  const readFile = async () => {
    const existing = await readJson(filePath, undefined)
    if (existing === undefined) {
      const created = emptyFile(now().toISOString())
      await atomicJsonWrite(filePath, created)
      return created
    }
    if (!existing || typeof existing !== 'object') {
      throw new Error('want-to-go.local.json 格式无效。')
    }
    if (existing.schema_version !== 1) {
      throw new Error('want-to-go.local.json 的 schema_version 不受支持，请先迁移。')
    }
    return { ...existing, items: Array.isArray(existing.items) ? existing.items : [] }
  }

  const writeFile = async (file) => {
    const next = { ...file, generated_at: now().toISOString() }
    await atomicJsonWrite(filePath, next)
    return next
  }

  const read = async () => readFile()

  const add = async (input = {}) => {
    const place = normalizePlace(input.place)
    const note = normalizeNote(input.note)

    const addedAt = input.addedAt === undefined || input.addedAt === null || input.addedAt === ''
      ? localDate(now())
      : requireText(input.addedAt, '加入日期')
    if (!datePattern.test(addedAt)) throw new Error('加入日期必须使用 YYYY-MM-DD。')

    const file = await readFile()
    // 隐藏的条目同样参与去重：否则隐藏后再添加会产出两条同地点记录。
    if (file.items.some((item) => itemPlaceKey(item) === placeKey(place.countryCode, place.nameEn))) {
      throw new Error('这个地方已在想去列表中。')
    }

    const idBase = `wtg_${addedAt}_${slugify(place.nameEn)}`
    const usedIds = new Set(file.items.map((item) => item?.id))
    let id = idBase
    for (let suffix = 2; usedIds.has(id); suffix += 1) id = `${idBase}-${suffix}`

    const item = {
      id,
      place,
      ...(note ? { note } : {}),
      addedAt,
      hidden: false,
      source: 'local-editor',
    }
    await writeFile({ ...file, items: [...file.items, item] })
    return { id, item }
  }

  const update = async (input = {}) => {
    const id = requireText(input.id, '想去记录 id')
    const hasHidden = input.hidden !== undefined
    const hasNote = input.note !== undefined
    if (!hasHidden && !hasNote) throw new Error('没有需要更新的想去记录内容。')
    if (hasHidden && typeof input.hidden !== 'boolean') throw new Error('隐藏状态只能是 true 或 false。')
    const note = hasNote ? normalizeNote(input.note) : undefined

    const file = await readFile()
    const index = file.items.findIndex((item) => item?.id === id)
    if (index < 0) throw new Error('找不到这条想去记录。')

    const current = file.items[index]
    const next = { ...current }
    if (hasHidden) next.hidden = input.hidden
    if (hasNote) {
      // 传空串表示删除备注，而不是写入一个空备注。
      if (note) next.note = note
      else delete next.note
    }

    const items = [...file.items]
    items[index] = next
    await writeFile({ ...file, items })
    return { item: next }
  }

  const deleteHidden = async (input = {}) => {
    const ids = Array.isArray(input.ids)
      ? [...new Set(input.ids.filter((id) => typeof id === 'string' && id.trim()).map((id) => id.trim()))]
      : []
    if (ids.length === 0) throw new Error('没有可删除的隐藏想去记录。')

    const file = await readFile()
    const itemsById = new Map(file.items.filter((item) => typeof item?.id === 'string').map((item) => [item.id, item]))
    // 整批原子拒绝：只要有一个 id 不存在或没被隐藏，就一条也不删。
    const invalidIds = ids.filter((id) => itemsById.get(id)?.hidden !== true)
    if (invalidIds.length > 0) {
      throw new Error(`只能彻底删除已隐藏的想去记录。以下记录不符合条件：${invalidIds.join('、')}`)
    }

    const removed = new Set(ids)
    await writeFile({ ...file, items: file.items.filter((item) => !removed.has(item?.id)) })
    return { deletedIds: ids }
  }

  return { read, add, update, deleteHidden }
}
