/**
 * The format versions the Canonical values carry (3C-5 E: moved here from the V2 schema, which is in the compat
 * directory now): the official view writes the editor state's `schemaVersion` and the travel metadata's
 * (../store/projectCanonical.ts); the V2 files (../compat/v2/) are read and written with the same numbers.
 *
 * Constraint: Node 24 loads it directly (erasable-only TypeScript).
 */
export const PLACES_SCHEMA_VERSION = 1
export const TRAVEL_SCHEMA_VERSION = 2
export const WANT_TO_GO_SCHEMA_VERSION = 2
export const EDITOR_STATE_SCHEMA_VERSION = 2
export const MEDIA_SCHEMA_VERSION = 3
