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

export const rememberCity3DEnabled = (enabled: boolean) => {
  if (typeof window === 'undefined') return

  try {
    window.localStorage.setItem(city3DStorageKey, enabled ? 'on' : 'off')
  } catch {
    // The toggle still works for this session when storage is blocked.
  }
}
