/**
 * Synthetic V2 files with every kind of hidden content, for ./personal-build-filter.test.mjs and the closeBundle test.
 * Not a test file itself. Neutral invented places; hidden-only coordinates use distinctive values (…1313, …2121, …)
 * so a test can search the filtered JSON for them.
 *
 * Countries: A (visible), B (hidden, but a planned record in its city b2 stays), C (hidden, nothing else refers to it),
 * D (added, visible), E (added and hidden), F (only a hidden Want to Go city f1 is in it).
 * Cities: a1, a2 (visible); ax (hidden city: records and media only); ay (hidden city that a visible Want to Go entry
 * points at); b1, b2 (in B); c1 (in C); f1 (in F).
 */

const uuid = (n) => `019c0000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`

export const ID = Object.freeze({
  A: uuid(0x01), B: uuid(0x02), C: uuid(0x03), D: uuid(0x04), E: uuid(0x05), F: uuid(0x06),
  a1: uuid(0x11), a2: uuid(0x12), ax: uuid(0x13), ay: uuid(0x14), b1: uuid(0x21), b2: uuid(0x22), c1: uuid(0x31), f1: uuid(0x61),
})

const country = (id, en, iso, location) => ({ id, subtype: 'country', names: { en }, externalIds: { iso3166Alpha2: iso }, location })
const city = (id, en, partOf, location) => ({ id, subtype: 'city', names: { en }, partOf, location })

const media = (id, kind, placeId, files, extra = {}) => ({
  id, kind, scope: 'city', src: files.src, ...(files.variants ? { variants: files.variants } : {}),
  originalFileName: `${id}-original-name.jpg`, isCover: false, status: 'ready', ...extra, placeId,
})
const tiers = (hash, extension = '.jpg') => ({
  src: `/media/user/${hash}/original${extension}`,
  variants: {
    thumb: { src: `/media/user/${hash}/thumb.webp`, width: 640, height: 480 },
    preview: { src: `/media/user/${hash}/preview.webp`, width: 2400, height: 1800 },
    original: { src: `/media/user/${hash}/original${extension}`, width: 4000, height: 3000 },
  },
})

/** Fresh copy every call. */
export function hiddenContentFixture() {
  return structuredClone({
    places: {
      schema_version: 1,
      generated_at: '2026-10-15T00:00:00.000Z',
      places: [
        country(ID.A, 'Aland', 'IS', { lat: 64.5, lng: -18.5 }),
        country(ID.B, 'Bland', 'NO', { lat: 61, lng: 9 }),
        country(ID.C, 'Cland', 'FI', { lat: 62.3131, lng: 25.3131 }),
        country(ID.D, 'Dland', 'FO', { lat: 62, lng: -7 }),
        country(ID.E, 'Eland', 'GL', { lat: 72.5151, lng: -40.5151 }),
        country(ID.F, 'Fland', 'SE', { lat: 60.6161, lng: 15.6161 }),
        city(ID.a1, 'Alpha', ID.A, { lat: 64.1, lng: -21.9 }),
        city(ID.a2, 'Beta', ID.A, { lat: 65.7, lng: -18.1 }),
        city(ID.ax, 'Hiddenvik', ID.A, { lat: 63.1313, lng: -19.1313 }),
        city(ID.ay, 'Wishvik', ID.A, { lat: 66.1, lng: -17.1 }),
        city(ID.b1, 'Bergtown', ID.B, { lat: 60.2121, lng: 5.2121 }),
        city(ID.b2, 'Plantown', ID.B, { lat: 69.6, lng: 18.9 }),
        city(ID.c1, 'Cetown', ID.C, { lat: 60.4141, lng: 24.4141 }),
        city(ID.f1, 'Fetown', ID.F, { lat: 59.7171, lng: 18.7171 }),
      ],
    },
    travel: {
      schema_version: 2,
      generated_at: '2026-10-15T00:00:00.000Z',
      display: {
        overviewTarget: { lat: 64, lng: -18 },
        homeHiddenCountryIds: [ID.C],
        originCountryIds: [ID.C],
        regionCountryIds: [],
        regionIncludes: [],
        navigationHiddenCityIds: [ID.ax, ID.a2],
      },
      records: [
        { id: 'r-a1', start_date: '2025-01-01', end_date: '2025-01-02', trip_title: 'Loop', status: 'visited', journeyId: 'j1', placeId: ID.a1 },
        { id: 'r-ax-hidden', start_date: '2025-01-02', trip_title: 'Loop', status: 'visited', notes: 'hidden note', journeyId: 'j1', placeId: ID.ax },
        { id: 'r-a2', start_date: '2025-01-03', trip_title: 'Loop', status: 'visited', journeyId: 'j1', placeId: ID.a2 },
        { id: 'r-ay-hidden', start_date: '2024-05-01', status: 'visited', journeyId: 'j2', placeId: ID.ay },
        { id: 'r-b1-hidden', start_date: '2023-07-01', status: 'visited', journeyId: 'j3', placeId: ID.b1 },
        { id: 'r-b2-planned', start_date: '2027-06-01', status: 'planned', notes: 'still planned', placeId: ID.b2 },
        { id: 'r-c1-hidden', start_date: '2022-03-01', status: 'visited', journeyId: 'j4', placeId: ID.c1 },
      ],
    },
    wantToGo: {
      schema_version: 2,
      items: [
        { id: 'w-ay', placeId: ID.ay, note: 'visible wish in a hidden city', addedAt: '2026-01-01', hidden: false },
        { id: 'w-f1-hidden', placeId: ID.f1, note: 'hidden wish', addedAt: '2026-01-02', hidden: true },
        { id: 'w-a2-hidden', placeId: ID.a2, addedAt: '2026-01-03', hidden: true },
        { id: 'w-d', placeId: ID.D, addedAt: '2026-01-04', hidden: false },
      ],
    },
    editorState: {
      schemaVersion: 2,
      addedCountries: [{ placeId: ID.D, region: 'Europe', visitedDate: '2024-01-01' }, { placeId: ID.E, region: 'Americas' }],
      countryOrder: [ID.B, ID.A, ID.C, ID.D],
      hiddenCountryIds: [ID.B, ID.C, ID.E],
      cityOrderByCountry: { [ID.A]: [ID.a2, ID.ax, ID.ay, ID.a1], [ID.B]: [ID.b1, ID.b2], [ID.C]: [ID.c1] },
      hiddenCityIds: [ID.ax, ID.ay],
      mediaOrderByCity: { [ID.a1]: ['p-hidden', 'p2', 'p1'], [ID.ax]: ['p-ax'] },
      hiddenMediaIds: ['p-hidden'],
      coverMediaByCity: { [ID.a1]: 'p-hidden', [ID.ax]: 'p-ax' },
      droneOrderByCity: { [ID.a1]: ['d-hidden', 'd1'], [ID.ax]: ['d-ax'] },
      hiddenDroneMediaIds: ['d-hidden'],
      updatedAt: '2026-10-15T00:00:00.000Z',
    },
    media: {
      schemaVersion: 3,
      generatedAt: '2026-10-15T00:00:00.000Z',
      items: [
        media('p1', 'photo', ID.a1, tiers('1111111111111111')),
        media('p2', 'photo', ID.a1, { src: '/media/user/legacy/p2.jpg' }),
        media('p-hidden', 'photo', ID.a1, tiers('2222222222222222')),
        media('d1', 'aerialPhoto', ID.a1, tiers('3333333333333333'), { date: '2025-01-01', resolution: '4000x3000', position: { lat: 64.2, lng: -21.8 } }),
        media('d-hidden', 'aerialPhoto', ID.a1, tiers('4444444444444444'), { date: '2025-01-01', resolution: '4000x3000', position: { lat: 64.4444, lng: -18.4444 } }),
        media('p-ax', 'photo', ID.ax, tiers('5555555555555555')),
        media('d-ax', 'panorama360', ID.ax, tiers('6666666666666666'), { date: '2025-01-02', resolution: '8000x4000', position: { lat: 63.5555, lng: -19.5555 } }),
        media('p-b1', 'photo', ID.b1, tiers('7777777777777777')),
      ],
    },
  })
}

/** What the filter must remove from `hiddenContentFixture()`. */
export const REMOVED = Object.freeze({
  records: ['r-ax-hidden', 'r-ay-hidden', 'r-b1-hidden', 'r-c1-hidden'],
  wantToGo: ['w-f1-hidden', 'w-a2-hidden'],
  media: ['p-hidden', 'd-hidden', 'p-ax', 'd-ax', 'p-b1'],
  places: [ID.C, ID.E, ID.F, ID.ax, ID.b1, ID.c1, ID.f1],
  /** Coordinates that only removed content carried. */
  coordinates: ['62.3131', '25.3131', '72.5151', '40.5151', '60.6161', '15.6161', '63.1313', '19.1313',
    '60.2121', '5.2121', '60.4141', '24.4141', '59.7171', '18.7171', '64.4444', '18.4444', '63.5555', '19.5555'],
  mediaHashes: ['2222222222222222', '4444444444444444', '5555555555555555', '6666666666666666', '7777777777777777'],
})

/** Hidden countries and cities that stay as places, because visible content still points at them. */
export const KEPT_HIDDEN_PLACES = Object.freeze([ID.B, ID.b2, ID.ay])
