import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import { V2WriteError } from '../src/data/v2write/errors.ts'

const defaultExecFileAsync = promisify(execFile)
const blockingPattern = /需要处理|缺少日期或分辨率|缺少日期、分辨率或有效坐标|无法读取|找不到国家|找不到城市/

const executionFailure = (error, stage) => {
  const reason = error instanceof Error ? error.message : String(error ?? '未知错误')
  const failure = new V2WriteError('E_MEDIA_IMPORT_FAILED', { reason, stage })
  failure.message = reason
  // Keep each stream unchanged, including its trailing newline. Do not repeat an
  // existing details value when it is already present in the captured output.
  const output = [error?.stdout, error?.stderr]
    .filter((value) => typeof value === 'string' && value.length > 0)
    .join('\n')
  const details = typeof error?.details === 'string' ? error.details : undefined
  if (output) failure.details = details && !output.includes(details) ? `${output}\n${details}` : output
  else if (details !== undefined) failure.details = details
  return failure
}

/** Loopback editor importer: preflight must succeed and contain no unresolved data before apply. */
export function createLocalEditorImporter({ webRoot, privateRoot, execFileAsync = defaultExecFileAsync }) {
  return async () => {
    const script = path.join(webRoot, 'scripts', 'import-media.mjs')
    const options = {
      cwd: webRoot,
      env: { ...process.env, STARMAP_PRIVATE_ROOT: privateRoot },
      maxBuffer: 8 * 1024 * 1024,
    }
    const execute = async (stage, args) => {
      try {
        return await execFileAsync(process.execPath, args, options)
      } catch (error) {
        throw executionFailure(error, stage)
      }
    }
    const preflight = await execute('preflight', [script])
    const preflightOutput = `${preflight.stdout}\n${preflight.stderr}`
    if (blockingPattern.test(preflightOutput)) {
      const failure = new V2WriteError('E_MEDIA_IMPORT_BLOCKED')
      failure.details = preflightOutput.trim()
      throw failure
    }
    const imported = await execute('apply', [script, '--apply'])
    return `${imported.stdout}\n${imported.stderr}`.trim()
  }
}
