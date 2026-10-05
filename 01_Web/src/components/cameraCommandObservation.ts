export type CameraCommandState = {
  commandNumber: number
  source: string
  selectedCityId?: string
  selectedCountryId?: string
  status: 'issued' | 'flying' | 'completed' | 'cancelled' | 'failed'
  issuedAt: number
  changedAt: number
}

export type CameraCommandObservation = {
  start: () => void
  complete: () => void
  cancel: () => void
  fail: () => void
}

/** DEV diagnostics only: observes callbacks; never controls a camera or animation. */
export function createCameraCommandObserver(now: () => number = Date.now) {
  let current: CameraCommandState | undefined
  let owner: object | undefined
  return {
    bind: (nextOwner: object) => {
      if (owner === nextOwner) return
      current = undefined
      owner = nextOwner
    },
    read: (expectedOwner?: object): Readonly<CameraCommandState> | undefined =>
      current && (!expectedOwner || expectedOwner === owner) ? { ...current } : undefined,
    clear: () => { current = undefined },
    issue: (command: Pick<CameraCommandState, 'commandNumber' | 'source' | 'selectedCityId' | 'selectedCountryId'>): CameraCommandObservation => {
      const issuedAt = now()
      const state: CameraCommandState = { ...command, status: 'issued', issuedAt, changedAt: issuedAt }
      current = state
      const transition = (status: CameraCommandState['status']) => {
        // Superseded commands and callbacks from a disposed viewer cannot change
        // the latest command. Terminal states cannot be restarted or overwritten.
        if (current !== state || !['issued', 'flying'].includes(state.status)) return
        if (status === 'completed' && state.status !== 'flying') return
        state.status = status
        state.changedAt = now()
      }
      return {
        start: () => transition('flying'),
        complete: () => transition('completed'),
        cancel: () => transition('cancelled'),
        fail: () => transition('failed'),
      }
    },
  }
}
