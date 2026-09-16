const mapLabelsStorageKey = 'starmap:map-labels'

// Defaults to on so the Google / Tianditu annotation overlay matches the previous always-visible behavior.
export const getInitialMapLabelsEnabled = (): boolean => {
  if (typeof window === 'undefined') return true

  try {
    return window.localStorage.getItem(mapLabelsStorageKey) !== 'off'
  } catch {
    return true
  }
}

export const rememberMapLabelsEnabled = (enabled: boolean) => {
  if (typeof window === 'undefined') return

  try {
    window.localStorage.setItem(mapLabelsStorageKey, enabled ? 'on' : 'off')
  } catch {
    // The toggle still works for this session when storage is blocked.
  }
}
