/** Explicit experimental branch + sealed backup read-only adapter.
 * Holds the target snapshot lock across backup validation/report construction;
 * it never reserves a later write, recovers a hot journal or loads App data. */
import { validateJson, freezeCopy } from '../src/worldgraph/store/schema.ts'
import { RepositoryError } from './world-store-repository.mjs'
import { repositoryStateDigest as digest } from './world-store-repository-v2-contract.mjs'
import { openRepositoryBranch } from './world-store-branch.mjs'
import { verifyRepositoryBranchBackup } from './world-store-branch-backup.mjs'
import { previewRepositoryBranchHistory } from './world-store-branch-history-preview.mjs'

export function previewRepositoryBranchHistoryIntake(targetDirectory, backupDirectory, options = {}) {
  validateJson(options)
  validateJson(options.policy ?? {})
  const policy = freezeCopy(options.policy ?? {})
  const branch = openRepositoryBranch(targetDirectory, { readOnly: true, policy })
  try {
    return branch.withSnapshot(snapshot => {
      const pkg = verifyRepositoryBranchBackup(backupDirectory, { policy })
      const raw = { format: 'starmap.repository-branch-history-intake', formatVersion: 1,
        packageDigest: digest(pkg.manifest), report: previewRepositoryBranchHistory(snapshot, pkg.snapshot, policy) }
      return freezeCopy({ ...raw, previewDigest: digest(raw) })
    })
  } finally { branch.close() }
}

export function assertRepositoryBranchHistoryIntakeCurrent(report, targetDirectory, backupDirectory, options = {}) {
  validateJson(report)
  const current = previewRepositoryBranchHistoryIntake(targetDirectory, backupDirectory, options)
  if (digest(report) !== digest(current)) throw new RepositoryError('E_BRANCH_HISTORY_PREVIEW_STALE')
  return current
}
