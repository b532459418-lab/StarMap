/**
 * Browser access for the release update check (./releaseUpdates.ts). A full, disabled or missing store reads as
 * "nothing cached / nothing recorded" and writes nothing, and a refused clipboard reports failure: neither may stop
 * the About page from opening or leave an unhandled rejection.
 */
export type UpdateStorage = Pick<Storage, 'getItem' | 'setItem'>
type UpdateClipboard = Pick<Clipboard, 'writeText'>

// Reading window.localStorage itself throws when the browser blocks site data, so the lookup stays inside each try.
const browserStorage = (): UpdateStorage => window.localStorage

export function readUpdateStorage(key: string, storage: () => UpdateStorage = browserStorage): string | null {
  try {
    return storage().getItem(key)
  } catch {
    return null
  }
}

export function writeUpdateStorage(key: string, value: string, storage: () => UpdateStorage = browserStorage): void {
  try {
    storage().setItem(key, value)
  } catch { /* The result still applies to this session when storage is full or blocked. */ }
}

const browserClipboard = (): UpdateClipboard | undefined => navigator.clipboard

/** True only when the text reached the clipboard. */
export async function copyUpdateText(text: string, clipboard: () => UpdateClipboard | undefined = browserClipboard): Promise<boolean> {
  try {
    const target = clipboard()
    if (!target) return false
    await target.writeText(text)
    return true
  } catch {
    return false
  }
}
