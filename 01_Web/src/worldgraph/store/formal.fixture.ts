/** Test helpers only: neutral hand-written data and G1 <-> formal conversion of
 * the shared tables. Views are not converted. Not part of any Core API. */
import type { StoreTable, WorldStore } from './types.ts'
import { type FormalState, readFormalState } from './formal.ts'
import { STORE_TABLES, readWorldStore } from './schema.ts'
import { fixture, id } from './store.fixture.ts'

const COMMON: readonly StoreTable[] = STORE_TABLES.filter(table => table !== 'viewStates')

export function formalFromWorld(world: WorldStore): FormalState {
  const state: Record<string, unknown> = {revision:world.revision,tombstones:[],viewItems:[],viewSettings:[]}
  for (const table of COMMON) state[table] = structuredClone(world[table])
  return state as unknown as FormalState
}
export function worldFromFormal(state: FormalState): WorldStore {
  const world: Record<string, unknown> = {format:'starmap.world-store',formatVersion:1,revision:state.revision,viewStates:[]}
  for (const table of COMMON) world[table] = structuredClone(state[table as keyof FormalState])
  return world as unknown as WorldStore
}
/** The G1 fixture without its viewStates row: only tables both paths share. */
export const commonFixture = (): WorldStore => readWorldStore({...fixture(),viewStates:[]})
export const LAYER_SCOPE = 'layer:user:reading'
export function formalFixture(): FormalState {
  return readFormalState({...formalFromWorld(commonFixture()),
    viewItems:[
      {id:'item-a',revision:0,scope:LAYER_SCOPE,itemTable:'entries',itemId:id(12),layerId:'user:reading',position:'V',hidden:false},
      {id:'item-b',revision:0,scope:LAYER_SCOPE,itemTable:'entries',itemId:id(10),layerId:'user:reading',position:'k',hidden:true},
    ],
    viewSettings:[{id:'cover-one',revision:0,scope:'entity:'+id(1),key:'cover',ref:{table:'assets',id:'synthetic-asset'}}],
  })
}
