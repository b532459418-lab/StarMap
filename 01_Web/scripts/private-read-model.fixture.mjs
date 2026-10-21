/**
 * Test helpers (3C-5B): the read model the private-data virtual module serves (`privateReadModel`), seen as the App
 * sees it (the official view, Canonical) or as the five V2 files of its V2 view, for the tests that were written
 * against the V2 files the module served before. Not a test file itself.
 */
import { officialViewOf } from '../src/data/store/projectCanonical.ts'
import { formalStateOfReadModel } from '../src/worldgraph/readModel/build.ts'
import { projectToV2Files } from './store-projection.mjs'

/** The App's Canonical of a served module (its official view with source 'local'). */
export const servedCanonical = (module) => officialViewOf(module.privateReadModel, 'local')

/** The five V2 files of a served module's read model (projection and serializeV2, as the V2 write functions see it). */
export const servedV2Files = (module) => projectToV2Files(formalStateOfReadModel(module.privateReadModel)).files
