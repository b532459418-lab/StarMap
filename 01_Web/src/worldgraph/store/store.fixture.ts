/** Neutral hand-written data; never imports App data or personal fixtures. */
import type { LayerEntry, SourceRef, WorldStore } from './types.ts'
import { emptyWorldStore, readWorldStore } from './schema.ts'
export const id = (n: number): string => `01900000-0000-7000-8000-${String(n).padStart(12,'0')}`
export const NOW = '2026-10-05T00:00:00.000Z'
export const title = (text: string) => ({names:{en:text,'zh-Hans':text}})
export const source = (recordId: string, sourceId = 'test:manual'): SourceRef => ({sourceId,recordId,evidenceIds:[]})
export const entry = (n: number, layerId = 'user:reading'): LayerEntry => ({
  id:id(n),revision:0,entityId:id(1),layerId,source:source(`record-${n}`),
  fields:{rating:5},createdAt:NOW,updatedAt:NOW,
})
export function fixture(): WorldStore {
  return readWorldStore({...emptyWorldStore(),
    sources:[
      {id:'test:manual',revision:0,title:title('Synthetic manual'),origin:'user'},
      {id:'test:planned',revision:0,title:title('Synthetic plans'),origin:'rule'},
      {id:'test:saved',revision:0,title:title('Synthetic saved'),origin:'import'},
      {id:'test:ai',revision:0,title:title('Synthetic AI'),origin:'ai'},
    ],
    evidence:[{id:'proof-one',revision:0,sourceId:'test:saved',recordId:'opaque-import',attributes:{citation:'Neutral test evidence'}}],
    entityTypes:[{id:'custom:book',revision:0,title:title('Book'),schemaVersion:1,fields:[{key:'author',kind:'text',required:true},{key:'related',kind:'entity_ref'},{key:'cover',kind:'asset_ref'}]}],
    layers:[
      {id:'user:reading',revision:0,title:title('Reading'),schemaVersion:1,acceptedEntityTypes:['custom:book'],entryFields:[{key:'rating',kind:'number',min:0,max:5},{key:'note',kind:'text'},{key:'readAt',kind:'date'},{key:'dateEvidence',kind:'date_evidence'}]},
      {id:'user:favorites',revision:0,title:title('Favorites'),schemaVersion:1,acceptedEntityTypes:[],entryFields:[{key:'rating',kind:'number'}]},
    ],
    entities:[1,2,3,4].map(n=>({id:id(n),revision:0,typeId:'custom:book',title:title(`Neutral book ${n}`),fields:{author:'Synthetic author'},source:source(`entity-${n}`),visibility:'private'})),
    entries:[10,11,12].map((n,i)=>({...entry(n),entityId:id(i+1)})),
    relationTypes:[{id:'custom:related',revision:0,title:title('Related'),schemaVersion:1,fromTypes:['custom:book'],toTypes:['custom:book'],fields:[{key:'note',kind:'text'}]}],
    relations:[{id:'relation-one',revision:0,typeId:'custom:related',fromEntityId:id(1),toEntityId:id(2),source:source('relation'),fields:{note:'Synthetic relation'}}],
    anchors:[
      {id:'location-one',revision:0,entityId:id(1),kind:'location',lat:0,lng:0,precision:'exact',approximate:true,source:source('location')},
      {id:'time-one',revision:0,entityId:id(1),kind:'time',date:{raw:{startDate:'2025',endDate:'2025-06',year:2025}},precision:'exact',source:source('time')},
    ],
    assets:[{id:'synthetic-asset',revision:0,source:source('asset'),attributes:{mediaType:'photo'}}],
    sequences:[{id:'original-order',revision:0,entityId:id(4),entryIds:[id(10),id(11),id(12)],source:source('sequence')}],
    viewStates:[{id:'view-one',revision:0,layerId:'user:reading',orderedEntryIds:[id(12),id(10),id(11)],hiddenEntryIds:[id(11)]}],
  })
}
