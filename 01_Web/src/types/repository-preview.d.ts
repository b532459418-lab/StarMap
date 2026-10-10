declare module 'virtual:starmap-repository-preview' {
  /** A Node-validated capture of an owned synthetic Store. No host or write capability is exported. */
  export const repositoryPreview: {
    format: 'starmap.repository-readonly-preview'
    formatVersion: 1
    readOnly: true
    synthetic: true
    canonical: import('../data/canonical/types.ts').CanonicalData
    now: string
    identity: { libraryId: string; branchId: string; genesisId: string }
    savedDigest: string
    stateDigest: string
    projectionEnvelopeDigest: string
  } | null
}
