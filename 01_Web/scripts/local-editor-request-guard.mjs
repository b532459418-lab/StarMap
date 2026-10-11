/**
 * Request checks for the personal-profile dev server. Pure decisions over a Node request-like object
 * (`{ headers, socket: { remoteAddress } }`), plus the guard middleware built on them; no file or network access.
 *
 * Every page a browser shows from localhost, 127.0.0.1 or [::1] runs on this machine, so a loopback socket alone
 * does not tell this app's own page from another local page (another dev server, a local tool, a compromised
 * dependency). Browsers label each request with `Sec-Fetch-Site`; these checks use it:
 *
 * - `isCrossSiteSubresourceRequest` (global guard, ahead of Vite's own middlewares): a request from another site
 *   (`cross-site`), or from another host/port of the same site (`same-site`, e.g. http://localhost:5999), is refused
 *   unless it opens a page (`Sec-Fetch-Mode: navigate`). Links from elsewhere still open the app; scripts, fetches,
 *   images and module imports from another origin get 403. This covers the private-data virtual module, `/@fs/`,
 *   `/media/user/*` and the editor endpoints.
 * - `authorizeRead` (read-only editor endpoints and `/media/user/*`): loopback socket, an allowed Origin when one is
 *   supplied, and `Sec-Fetch-Site` absent, `same-origin` or `none`.
 *
 * Requests without `Sec-Fetch-*` headers (curl, Node tests) pass the guard and are left to the endpoint checks.
 */

const lowerToken = (value) => typeof value === 'string' ? value.trim().toLowerCase() : undefined

/** The socket is this machine. */
export const isLoopbackRequest = (request) => {
  const address = request.socket?.remoteAddress ?? ''
  return address === '::1' || address === '127.0.0.1' || address.startsWith('::ffff:127.')
}

/** No Origin, or an http localhost/127.0.0.1 Origin equal to this server's own origin (same port). */
export const allowedOrigins = (request) => {
  const origin = request.headers.origin
  if (!origin) return true
  try {
    const parsed = new URL(origin)
    return (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost')
      && parsed.protocol === 'http:'
      && typeof request.headers.host === 'string'
      && parsed.origin === new URL(`http://${request.headers.host}`).origin
  } catch {
    return false
  }
}

const readableFetchSites = new Set(['same-origin', 'none'])

/** `Sec-Fetch-Site` is absent (not a browser), `same-origin`, or `none` (typed address, bookmark). */
export const isSameOriginFetchSite = (request) => {
  const raw = request.headers['sec-fetch-site']
  return raw === undefined || readableFetchSites.has(lowerToken(raw))
}

/** Read-only editor endpoints and `/media/user/*`. Writes keep their own, stricter `authorizeWrite`. */
export const authorizeRead = (request) => (
  isLoopbackRequest(request)
  && allowedOrigins(request)
  && isSameOriginFetchSite(request)
)

/** The global guard's decision: another site or another origin of this site, and not a page navigation. */
export const isCrossSiteSubresourceRequest = (request) => {
  const site = lowerToken(request.headers['sec-fetch-site'])
  if (site !== 'cross-site' && site !== 'same-site') return false
  return lowerToken(request.headers['sec-fetch-mode']) !== 'navigate'
}

/** Connect middleware for `server.middlewares.use`. Refuses before any Vite handler sees the request. */
export const crossSiteRequestGuard = (request, response, next) => {
  if (!isCrossSiteSubresourceRequest(request)) {
    next()
    return
  }
  response.statusCode = 403
  response.setHeader('content-type', 'text/plain; charset=utf-8')
  response.setHeader('cache-control', 'no-store')
  response.end('Forbidden')
}
