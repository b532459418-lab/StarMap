/**
 * Test helpers (3C-5B): the read model the private-data virtual module names (`privateReadModelUrl`, the dev server's
 * read-only endpoint), seen as the App sees it (the official view, Canonical) or as the five V2 files of its V2 view, for
 * the tests that were written against the V2 files the module served before. Not a test file itself.
 */
import { officialViewOf } from '../src/data/store/projectCanonical.ts'
import { formalStateOfReadModel } from '../src/worldgraph/readModel/build.ts'
import { projectToV2Files } from './compat/store-projection.mjs'

/**
 * The served module (`code`: its source, loaded from `plugin` when not given) as a plain object, with `privateReadModel`
 * added: what the plugin's read-model endpoint answers for the address the module names (plugin.api.readModelResponse,
 * the endpoint's own function), when it answers 200. A build's data file is not an endpoint address: it stays out.
 */
export async function servedModuleOf(plugin, code) {
  const source = code ?? await plugin.load(plugin.resolveId('virtual:starmap-private-data'))
  const module = { ...(await import(`data:text/javascript,${encodeURIComponent(source)}`)) }
  if (typeof module.privateReadModelUrl === 'string' && module.privateReadModelUrl.startsWith('__travelatlas/editor/read-model?')) {
    const response = await plugin.api.readModelResponse()
    if (response.status === 200) module.privateReadModel = JSON.parse(response.body.toString('utf8'))
  }
  return module
}

/** The App's Canonical of a served module (its official view with source 'local'). */
export const servedCanonical = (module) => officialViewOf(module.privateReadModel, 'local')

/** The five V2 files of a served module's read model (projection and serializeV2, as the V2 write functions see it). */
export const servedV2Files = (module) => projectToV2Files(formalStateOfReadModel(module.privateReadModel)).files
