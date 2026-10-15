/**
 * Country flags (batch 7, review S4): flag-icons' 4×3 SVGs (MIT) ship with the project instead of being loaded from a
 * third-party flag service, so no country code and no Referer leave the page.
 *
 * This module is the pure part, loadable by Node tests. The Vite-only `import.meta.glob` that lists the files lives in
 * ../components/countryFlagUrl.ts.
 *
 * Constraints: Node 24 loads it directly (erasable-only TypeScript, no import.meta).
 */

const FLAG_FILE = /^\.\/([a-z]{2})\.svg$/

/** The glob's result (keys such as `./is.svg`, values the built URLs) as two-letter code → URL. */
export const flagUrlsByCode = (files: Readonly<Record<string, string>>): ReadonlyMap<string, string> => {
  const urls = new Map<string, string>()
  for (const [file, url] of Object.entries(files)) {
    const code = FLAG_FILE.exec(file)?.[1]
    if (code) urls.set(code, url)
  }
  return urls
}

/**
 * A country's `flagCode` (ISO 3166-1 alpha-2, any letter case) → the bundled flag's URL. Undefined when there is no
 * such file (or no code): the interface then keeps its former fallback, the emoji flag or a dot.
 */
export const flagUrlFor = (urls: ReadonlyMap<string, string>, code: string | undefined): string | undefined => {
  const key = code?.trim().toLowerCase()
  return key && /^[a-z]{2}$/.test(key) ? urls.get(key) : undefined
}
