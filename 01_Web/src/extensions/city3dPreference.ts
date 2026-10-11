const city3DStorageKey = 'starmap:city-3d'

// Defaults to off so a first visit never starts billing Google 3D tiles on its own.
export const getInitialCity3DEnabled = (): boolean => {
  if (typeof window === 'undefined') return false

  try {
    return window.localStorage.getItem(city3DStorageKey) === 'on'
  } catch {
    return false
  }
}

/**
 * The initial City 3D state. Without a Google key neither the tiles nor the toggle render, so a stored 'on' must not
 * count: localStorage on 127.0.0.1:5173 is shared by the public, personal and preview profiles, and the globe hides
 * itself while City 3D is on. The stored preference is only read when a key is configured.
 */
export const resolveInitialCity3DEnabled = (
  googleConfigured: boolean,
  readStoredPreference: () => boolean = getInitialCity3DEnabled,
): boolean => googleConfigured && readStoredPreference()

export const rememberCity3DEnabled = (enabled: boolean) => {
  if (typeof window === 'undefined') return

  try {
    window.localStorage.setItem(city3DStorageKey, enabled ? 'on' : 'off')
  } catch {
    // The toggle still works for this session when storage is blocked.
  }
}
