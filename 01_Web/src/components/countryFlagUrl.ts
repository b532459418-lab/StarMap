import { flagUrlFor, flagUrlsByCode } from '../data/countryFlags.ts'

// Every flag is a file of its own in the build, requested only when an <img> shows it. `no-inline` matters: Vite would
// otherwise turn the flags under `build.assetsInlineLimit` (4 KiB, three in four of them) into data URIs inside the
// main bundle. Only two-letter names: flag-icons' regional flags (gb-eng, es-ct, …) never match a country code.
const flagUrls = flagUrlsByCode(import.meta.glob<string>('/node_modules/flag-icons/flags/4x3/[a-z][a-z].svg', {
  base: '/node_modules/flag-icons/flags/4x3/',
  query: '?url&no-inline',
  import: 'default',
  eager: true,
}))

/** The bundled 4×3 SVG for a country's `flagCode`, or undefined (callers keep their fallback). */
export const countryFlagUrl = (code: string | undefined): string | undefined => flagUrlFor(flagUrls, code)
