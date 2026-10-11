/**
 * Which repository paths must never be tracked or published. Used by the privacy audit (`privacy-audit.mjs`);
 * pure, so each rule has a unit test. Paths are relative to the repository root, with `/` or `\` separators.
 *
 * The rules mirror the `.gitignore` safeguards, so a file forced in with `git add -f` is still caught. The newer
 * rules (private roots at any depth, build output, `*.local`, `.env*` anywhere) compare case-insensitively.
 */

// A private root inside the repository: the standalone-clone fallback `06_private/` or a `.starmap-private/`
// (`STARMAP_PRIVATE_ROOT`), at any depth, as `.gitignore` matches them.
const privateRootSegments = new Set(['06_private', '.starmap-private'])

export const isPrivateTrackedPath = (filePath) => {
  const normalized = filePath.replaceAll('\\', '/')
  const lower = normalized.toLowerCase()
  const segments = lower.split('/')
  const baseName = segments.at(-1) ?? ''
  if (segments.some((segment) => privateRootSegments.has(segment))) return true
  if (normalized.startsWith('02_Assets/PrivateData/')) return true
  if (normalized.startsWith('01_Web/public/media/user/')) return true
  if (normalized.startsWith('01_Web/src/data/generated/')) return true
  // Build output: a personal build inlines private data and copies the original media.
  if (lower.startsWith('01_web/dist/')) return true
  if (normalized.includes('.local.') || lower.endsWith('.local')) return true
  if (normalized === '01_Web/src/data/travel_map_export.json') return true
  // Environment files in any directory (.env, .env.local, .env.production, .envrc, ...). Only .env.example is public.
  if (baseName.startsWith('.env')) return baseName !== '.env.example'
  if (normalized.startsWith('02_Assets/MediaInbox/')) {
    return normalized !== '02_Assets/MediaInbox/README.md'
      && !normalized.startsWith('02_Assets/MediaInbox/_country-template/')
  }
  return false
}
