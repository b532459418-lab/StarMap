import { isCalendarDate } from '../../worldgraph/timeFilter.ts'
import { wikidataItemId, type InterestInput, type InterestKind } from './templates.ts'

type ClaimValue = {
  id?: string
  text?: string
  time?: string
  precision?: number
  latitude?: number
  longitude?: number
  globe?: string
}
type Claim = {
  rank?: string
  mainsnak?: { datavalue?: { value: ClaimValue | string } }
  qualifiers?: Record<string, readonly { datavalue?: { value: string } }[]>
}
type Text = Record<string, { value?: string }>
type WikidataEntity = { id: string; missing?: unknown; labels?: Text; descriptions?: Text; claims?: Record<string, Claim[]> }

const qid = /^Q[1-9]\d{0,14}$/
const localized = (names: Text | undefined, zh: boolean): string => {
  const value = zh ? names?.['zh-hans']?.value ?? names?.zh?.value ?? names?.en?.value
    : names?.en?.value ?? names?.['zh-hans']?.value ?? names?.zh?.value
  return value ?? ''
}
function claims(entity: WikidataEntity, property: string) {
  const valid = (entity.claims?.[property] ?? []).filter((claim) => claim.rank !== 'deprecated' && claim.mainsnak?.datavalue)
  const preferred = valid.filter((claim) => claim.rank === 'preferred')
  return preferred.length && property !== 'P577' ? preferred : valid
}
function values(entity: WikidataEntity, property: string): ClaimValue[] {
  return claims(entity, property).flatMap((claim) => {
    const value = claim.mainsnak?.datavalue?.value
    return typeof value === 'object' && value !== null ? [value] : []
  })
}
const references = (entity: WikidataEntity, property: string) =>
  values(entity, property).flatMap((value) => value.id && qid.test(value.id) ? [value.id] : []).slice(0, 3)
const textClaim = (entity: WikidataEntity, property: string) =>
  claims(entity, property).map((claim) => claim.mainsnak?.datavalue?.value).find((value): value is string => typeof value === 'string') ?? ''

async function readEntities(ids: string[], props: string, signal: AbortSignal) {
  const query = new URLSearchParams({
    action: 'wbgetentities', ids: ids.join('|'), props, languages: 'zh-hans|zh|en',
    languagefallback: '1', redirects: 'yes', format: 'json', origin: '*',
  })
  const response = await fetch(`https://www.wikidata.org/w/api.php?${query}`, { signal, credentials: 'omit' })
  if (!response.ok) throw new Error('Wikidata HTTP ' + response.status)
  const json = await response.json() as { entities?: Record<string, WikidataEntity>; error?: unknown }
  if (!json.entities || json.error) throw new Error('Wikidata data')
  return Object.values(json.entities).filter((entity) => qid.test(entity.id) && entity.missing === undefined)
}

export async function readWikidataInterest(link: string, kind: InterestKind, zh: boolean, signal: AbortSignal): Promise<InterestInput | undefined> {
  const id = wikidataItemId(link)
  if (!id) return undefined
  const [entity] = await readEntities([id], 'labels|descriptions|claims', signal)
  const name = localized(entity?.labels, zh).slice(0, 250)
  if (!name || !entity) return undefined
  const details: Record<string, string> = {
    description: localized(entity.descriptions, zh).slice(0, 2000), sourceUrl: `https://www.wikidata.org/wiki/${entity.id}`,
  }
  const image = textClaim(entity, kind === 'movie' && textClaim(entity, 'P3383') ? 'P3383' : 'P18')
  if (image) details.imageUrl = 'https://commons.wikimedia.org/wiki/File:' + encodeURIComponent(image.replaceAll(' ', '_'))
  const object: InterestInput = { title: name, details, imported: { key: 'wikidata:' + entity.id, retrievedAt: new Date().toISOString() } }
  if (kind === 'food') {
    if (!references(entity, 'P31').includes('Q11707')) return undefined
    details.address = values(entity, 'P6375').find((value) => value.text)?.text ?? ''
    const point = values(entity, 'P625').find((value) => value.globe?.endsWith('/Q2')
      && typeof value.latitude === 'number' && typeof value.longitude === 'number')
    if (point?.latitude !== undefined && point.longitude !== undefined) object.place = { name, lat: point.latitude, lng: point.longitude }
    return object
  }
  if (kind === 'race') {
    if (!references(entity, 'P641').includes('Q100348482')) return undefined
    const time = values(entity, 'P585').find((value) => (value.precision ?? 0) >= 11)?.time ?? ''
    const date = /^\+(\d{4}-\d{2}-\d{2})T/.exec(time)?.[1]
    if (isCalendarDate(date)) details.raceDate = date
    const edition = claims(entity, 'P31').find((claim) => {
      const value = claim.mainsnak?.datavalue?.value
      return typeof value === 'object' && value.id === 'Q1191380'
    })?.qualifiers?.P1545?.find((value) => /^\d+$/.test(value.datavalue?.value ?? ''))?.datavalue?.value
    if (edition) details.edition = edition
    return object
  }

  const movieFields = { director: 'P57', writer: 'P58', studio: 'P272', genre: 'P136', country: 'P495' }
  const release = values(entity, 'P577').map((value) => /^\+(\d{4})-/.exec(value.time ?? '')?.[1]).filter(Boolean).sort()[0]
  if (!references(entity, movieFields.director).length || !release) return undefined
  details.release = release
  const related = Object.entries(movieFields).map(([field, property]) => [field, references(entity, property)] as const)
  const ids = [...new Set(related.flatMap(([, values]) => values))]
  const labels = new Map((await readEntities(ids, 'labels', signal)).map((item) => [item.id, localized(item.labels, zh)]))
  for (const [field, values] of related) details[field] = values.map((id) => labels.get(id)).filter(Boolean).join(zh ? '、' : ', ')
  return object
}
