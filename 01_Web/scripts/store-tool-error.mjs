/**
 * The error of the store tools (store:init, store:backup / restore, store:upgrade, store:export-read-model, store:migrate,
 * store:export-v2, the baseline): a refusal or a failure with its code. 3C-5 E: moved here from the migration
 * (./compat/store-migrate.mjs), so the ordinary tools do not import the compat directory.
 */

/** A refusal or failure of a store tool: `problems` are lines safe to print (no values from the private files). */
export class StoreToolError extends Error {
  constructor(code, problems = []) {
    super([code, ...problems].join('\n'))
    this.name = 'StoreToolError'
    this.code = code
    this.problems = Object.freeze([...problems])
  }
}
