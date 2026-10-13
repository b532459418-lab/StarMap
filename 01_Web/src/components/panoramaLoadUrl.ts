/**
 * The image URL for one load attempt in DronePanoramaModal. The first attempt uses the plain URL so the browser's HTTP
 * cache can serve a file it already holds (one panorama can be tens of MB); only a retry adds a unique query, so a
 * failed or half-written response is not served again from the cache.
 */
export function panoramaLoadUrl(source: string, attempt: number, now: number): string {
  if (attempt <= 0) return source
  const separator = source.includes('?') ? '&' : '?'
  return `${source}${separator}starmapLoad=${now}-${attempt}`
}
