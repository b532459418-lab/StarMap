import type { FormalEntityType, FormalFieldDefinition, FormalLayer } from '../../worldgraph/store/formal.ts'
import { OFFICIAL } from '../store/officialDefinitions.ts'

export const interestKinds = ['food', 'movie', 'race'] as const
export type InterestKind = typeof interestKinds[number]
export type LocalLabel = { readonly zh: string; readonly en: string }
export type DetailField = { readonly key: string; readonly label: LocalLabel; readonly kind?: 'date' | 'url' }

export const interestPrefix = 'starmap:interest:'
export const interestHiddenScope = 'starmap:interest.hidden'
export const interestPlaceSubtype = 'interest-point'
export const wikidataSource = 'starmap:interest.wikidata'

export const interestTemplates: Record<InterestKind, {
  title: LocalLabel
  activity: LocalLabel
  status: LocalLabel
  placeField: 'watchPlaceId' | 'activityPlaceId'
  fields: readonly DetailField[]
}> = {
  food: {
    title: { zh: '探店', en: 'Food & places' }, activity: { zh: '到访', en: 'Visit' },
    status: { zh: '已到访', en: 'Visited' }, placeField: 'activityPlaceId',
    fields: [
      { key: 'address', label: { zh: '地址', en: 'Address' } },
      { key: 'hours', label: { zh: '营业时间', en: 'Opening hours' } },
      { key: 'specialties', label: { zh: '招牌美食', en: 'Specialties' } },
    ],
  },
  movie: {
    title: { zh: '影视', en: 'Film & TV' }, activity: { zh: '观看', en: 'Viewing' },
    status: { zh: '已观看', en: 'Watched' }, placeField: 'watchPlaceId',
    fields: [
      { key: 'director', label: { zh: '导演', en: 'Director' } },
      { key: 'writer', label: { zh: '编剧', en: 'Writer' } },
      { key: 'studio', label: { zh: '出品方', en: 'Studio' } },
      { key: 'genre', label: { zh: '类型', en: 'Genre' } },
      { key: 'country', label: { zh: '出品国家或地区', en: 'Country of origin' } },
      { key: 'release', label: { zh: '上映时间', en: 'Release' } },
      { key: 'platformRating', label: { zh: '平台评分（注明来源和尺度）', en: 'External rating (source and scale)' } },
    ],
  },
  race: {
    title: { zh: '马拉松', en: 'Marathons' }, activity: { zh: '参赛', en: 'Race entry' },
    status: { zh: '已参赛', en: 'Ran' }, placeField: 'activityPlaceId',
    fields: [
      { key: 'raceDate', kind: 'date', label: { zh: '赛事日期', en: 'Race date' } },
      { key: 'edition', label: { zh: '届次', en: 'Edition' } },
      { key: 'distance', label: { zh: '距离／组别', en: 'Distance or division' } },
    ],
  },
}

const localTitle = ({ zh, en }: LocalLabel) => ({ names: { 'zh-Hans': zh, en } })
export const interestTypeId = (kind: InterestKind) => interestPrefix + kind
export const defaultLayerId = (kind: InterestKind) => interestPrefix + 'layer:' + kind
export const isInterestLayer = (id: string) => id.startsWith(interestPrefix + 'layer:')
export const interestKindOf = (typeId: string) => interestKinds.find((kind) => interestTypeId(kind) === typeId)
export const isInterestKind = (value: unknown): value is InterestKind => interestKinds.some((kind) => kind === value)

export const commonFields: readonly DetailField[] = [
  { key: 'description', label: { zh: '简介', en: 'Description' } },
  { key: 'imageUrl', kind: 'url', label: { zh: '封面／照片链接', en: 'Cover or photo URL' } },
  { key: 'sourceUrl', kind: 'url', label: { zh: '来源链接', en: 'Source URL' } },
]

export function interestEntityDefinition(kind: InterestKind): FormalEntityType {
  const template = interestTemplates[kind]
  const fields: FormalFieldDefinition[] = [...template.fields, ...commonFields]
    .map((field) => ({ key: field.key, kind: field.kind === 'date' ? 'date' : 'text' }))
  fields.push({ key: 'externalKey', kind: 'text' }, { key: 'retrievedAt', kind: 'text' })
  if (kind !== 'movie') fields.push({ key: 'placeId', kind: 'entity_ref', targetTypeId: OFFICIAL.place })
  return { id: interestTypeId(kind), revision: 0, title: localTitle(template.title), schemaVersion: 1, fields }
}

export function interestLayerDefinition(kind: InterestKind, id: string, name?: string): FormalLayer {
  return {
    id, revision: 0, title: name ? localTitle({ zh: name, en: name }) : localTitle(interestTemplates[kind].title),
    schemaVersion: 1, acceptedEntityTypes: [interestTypeId(kind)],
    entryFields: [
      { key: 'status', kind: 'text', required: true },
      { key: 'date', kind: 'date' },
      { key: 'rating', kind: 'number', min: 0, max: 5 },
      { key: 'note', kind: 'text' },
      { key: interestTemplates[kind].placeField, kind: 'entity_ref', targetTypeId: OFFICIAL.place },
      ...(kind === 'race' ? [{ key: 'finish', kind: 'text' as const }] : []),
    ],
  }
}

export type InterestPoint = { readonly name: string; readonly lat: number; readonly lng: number }
export type PlaceChoice = string | InterestPoint
export type ActivityInput = {
  status: 'saved' | 'planned' | 'done'
  date?: string
  rating?: number
  note?: string
  finish?: string
  place?: PlaceChoice
}
export type InterestInput = {
  title: string
  details: Record<string, string>
  place?: PlaceChoice
  imported?: { key: string; retrievedAt: string }
}
export type RowVersion = { id: string; revision: number }
export type InterestWrite =
  | { op: 'add'; kind: InterestKind; layerId: string; object: InterestInput; activity: ActivityInput }
  | { op: 'edit-object'; object: InterestInput; entity: RowVersion }
  | { op: 'add-activity'; layerId: string; entity: RowVersion; activity: ActivityInput }
  | { op: 'edit-activity'; entry: RowVersion; activity: ActivityInput }
  | { op: 'hide' | 'restore' | 'remove-activity'; entry: RowVersion }
  | { op: 'remove-object'; entity: RowVersion }
  | { op: 'create-layer'; kind: InterestKind; name: string }
  | { op: 'rename-layer'; layer: RowVersion; name: string }
  | { op: 'remove-place'; place: RowVersion }
export type InterestWriteResult = {
  id: string
  entityId?: string
  existingMatch?: boolean
}

export function wikidataItemId(value: string): string | undefined {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.port || url.username || url.password
      || !['wikidata.org', 'www.wikidata.org'].includes(url.hostname)) return undefined
    return /^\/wiki\/(Q[1-9]\d{0,14})\/?$/i.exec(url.pathname)?.[1].toUpperCase()
  } catch { return undefined }
}
