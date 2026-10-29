/** The official definitions of every version (3C-5 G), frozen: a version is never edited once it is released.
 *
 * officialDefinitions.ts holds the current version (OFFICIAL_DEFINITIONS, OFFICIAL_DEFINITIONS_VERSION). When it
 * changes, the version it replaces stays here as it was, and the new one is added. The test of
 * ./officialDefinitions.test.ts requires every version to be a compatible evolution of the one before (Core's
 * checkDefinitionChange: names, new optional fields, required to optional, wider lists…), and the last one to equal
 * OFFICIAL_DEFINITIONS. A store keeps no copy of these: `npm run store:upgrade` brings a store's rows to the current
 * version (./definitionUpgrades.ts), and the planner checks each change again.
 */
import type { OfficialDefinitionSet } from './definitionUpgrades.ts'

/** Version 1: the definitions of every store before 3C-5 G. */
const VERSION_1: OfficialDefinitionSet = {
  sources: [
    {
      id: 'starmap:user',
      revision: 0,
      title: {
        names: {
          en: 'StarMap',
          'zh-Hans': 'StarMap',
        },
      },
      origin: 'user',
    },
  ],
  entityTypes: [
    {
      id: 'starmap:place',
      revision: 0,
      title: {
        names: {
          en: 'Place',
          'zh-Hans': '地点',
        },
      },
      schemaVersion: 1,
      fields: [
        {
          key: 'subtype',
          kind: 'text',
          required: true,
        },
        {
          key: 'iso3166Alpha2',
          kind: 'text',
        },
      ],
    },
    {
      id: 'starmap:journey',
      revision: 0,
      title: {
        names: {
          en: 'Journey',
          'zh-Hans': '行程',
        },
      },
      schemaVersion: 1,
      fields: [],
    },
    {
      id: 'starmap:media',
      revision: 0,
      title: {
        names: {
          en: 'Media',
          'zh-Hans': '媒体',
        },
      },
      schemaVersion: 1,
      fields: [
        {
          key: 'place',
          kind: 'entity_ref',
          required: true,
        },
        {
          key: 'asset',
          kind: 'asset_ref',
          required: true,
        },
      ],
    },
  ],
  relationTypes: [
    {
      id: 'starmap:part-of',
      revision: 0,
      title: {
        names: {
          en: 'Part of',
          'zh-Hans': '属于',
        },
      },
      schemaVersion: 1,
      fromTypes: ['starmap:place'],
      toTypes: ['starmap:place'],
      fields: [],
    },
  ],
  layers: [
    {
      id: 'starmap:travel',
      revision: 0,
      title: {
        names: {
          en: 'Footprints',
          'zh-Hans': '足迹',
        },
      },
      schemaVersion: 1,
      systemKey: 'travel',
      acceptedEntityTypes: ['starmap:place'],
      entryFields: [
        {
          key: 'date',
          kind: 'date_evidence',
          required: true,
        },
        {
          key: 'note',
          kind: 'text',
        },
        {
          key: 'tripTitle',
          kind: 'text',
        },
      ],
    },
    {
      id: 'starmap:want-to-go',
      revision: 0,
      title: {
        names: {
          en: 'Want to Go',
          'zh-Hans': '想去',
        },
      },
      schemaVersion: 1,
      systemKey: 'want_to_go',
      acceptedEntityTypes: ['starmap:place'],
      entryFields: [
        {
          key: 'date',
          kind: 'date_evidence',
        },
        {
          key: 'addedAt',
          kind: 'date',
        },
        {
          key: 'note',
          kind: 'text',
        },
        {
          key: 'tripTitle',
          kind: 'text',
        },
      ],
    },
  ],
}

export const OFFICIAL_DEFINITION_HISTORY: Readonly<Record<number, OfficialDefinitionSet>> = Object.freeze({ 1: VERSION_1 })
