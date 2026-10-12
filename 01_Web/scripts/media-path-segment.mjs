/**
 * One rule for Inbox path segments (review D9): the country and city folders the local editor creates, uploaded file
 * names, and every segment of a path a media task records. Both the upload (`local-editor-upload.mjs`'s `safeSegment`)
 * and the task store (`media-job-store.mjs`) use it, so a folder the upload creates is always a path the task accepts.
 *
 * `isSafePathSegment(name)`: `name` can be used as one segment as it is.
 *
 * `toSafePathSegment(value, field)`: turns a display name into such a segment. What can be escaped is escaped, not refused:
 * 1. surrounding white space is trimmed;
 * 2. `< > : " / \ | ? *` and control characters (U+0000–U+001F, U+007F–U+009F) become `-`;
 * 3. an empty result, `.` or `..` is refused with `E_MEDIA_NAME_INVALID` (`field` names the input);
 * 4. at most 120 UTF-16 code units are kept, without splitting a surrogate pair;
 * 5. a Windows device name (CON, PRN, AUX, NUL, COM1–COM9, LPT1–LPT9, COM¹–COM³, LPT¹–LPT³, CONIN$, CONOUT$, any case),
 *    alone or followed by `.`, gets `_` right after it: `CON` → `CON_`, `nul.jpg` → `nul_.jpg`;
 * 6. a trailing `.` or space (Windows silently drops them) gets `_` after it: `Washington D.C.` → `Washington D.C._`.
 * A name that already is a safe segment comes back unchanged, so existing folders keep their names.
 */
import { V2WriteError } from '../src/data/v2write/errors.ts'

const MAX_SEGMENT_LENGTH = 200
const MAX_ESCAPED_LENGTH = 120
const RESERVED_CHARACTERS = '<>:"/\\|?*'
const DEVICE_NAME = /^(con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?=\.|$)/i
const TRAILING_DOT_OR_SPACE = /[. ]$/

const isControl = (character) => {
  const code = character.codePointAt(0)
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f)
}
const isForbidden = (character) => isControl(character) || RESERVED_CHARACTERS.includes(character)

export const isSafePathSegment = (name) => typeof name === 'string' && name.length > 0 && name.length <= MAX_SEGMENT_LENGTH
  && !Array.from(name).some(isForbidden)
  && !TRAILING_DOT_OR_SPACE.test(name) && !DEVICE_NAME.test(name)
  && name !== '.' && name !== '..'

export const toSafePathSegment = (value, field = 'media_filename') => {
  let name = Array.from(String(value ?? '').trim(), (character) => (isForbidden(character) ? '-' : character)).join('')
  if (!name || name === '.' || name === '..') throw new V2WriteError('E_MEDIA_NAME_INVALID', { field })
  if (name.length > MAX_ESCAPED_LENGTH) {
    const last = name.charCodeAt(MAX_ESCAPED_LENGTH - 1)
    name = name.slice(0, last >= 0xd800 && last <= 0xdbff ? MAX_ESCAPED_LENGTH - 1 : MAX_ESCAPED_LENGTH)
  }
  name = name.replace(DEVICE_NAME, '$1_')
  if (TRAILING_DOT_OR_SPACE.test(name)) name = `${name}_`
  return name
}
