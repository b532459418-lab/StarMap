/**
 * 媒体导入（RFC-LOC-1 PR3b-3 规格 §2.1–§2.3、§2.5）。
 *
 * 入口是 scripts/import-media.mjs（`npm run media:check` / `media:import`）：PR5a 起旧格式的导入器已删除，入口只检查
 * 私人目录有没有没迁移的旧数据（有则拒绝，退出码 2），然后调用这里的 runV2MediaImport。
 *
 * 3C-4d：个人数据只写新库。media:import 只走 ../store-media-cli.mjs；在不是新库的私人根上，media:check 用这里做只读预检
 * （不取库租约，不写任何文件）。3C-5 E 删除了 runV2MediaImport 的写入（3C-4d 起生产代码已经没有入口，只为测试生成迁移
 * 输入）：测试要的「V2 导入之后的库」由 ./v2-media-import.fixture.mjs 按这里的只读计划写出。
 * 投递箱的遍历（walkInbox）与生成文件的发布（publishGeneratedFiles）在 ../media-inbox.mjs，新库的导入与这里共用；
 * 只读计划（scanV2MediaImport）给测试夹具与 store:export-v2 的只读比对用。
 *
 * 兼容（3C-5 E 规格 §2.4）：V2 文件只为迁移、待迁移私人根的只读显示与导出而读写；普通的读写代码不引用兼容目录
 * （scripts/compat-boundary.test.mjs）。这里是待迁移私人根上 media:check 的只读预检。
 * 预检的流程与旧导入器相同（扫描投递箱 → 打印报告），规则只有三处不同（下面「写盘」与「发布」两条说的是 3C-5 E 之前的写入，
 * 计划与发布函数照旧：测试夹具按计划写，新库的导入用同一个发布函数）：
 *
 * - **归属**：从地点注册表（data/v2/places.local.json）建索引，国家文件夹按 place.json → 旧 country.json 的 countryId
 *   （经 legacyKeys）→ 文件夹名解析，城市文件夹按 place.json → 文件夹名解析；不读旧足迹文件，也不回落到样例。
 *   0 个或多个候选都报错，不猜，不新建地点。
 * - **文件夹绑定需要确认（第 2A 批，RFC ID-6「匹配提示 ≠ 身份」）**：按文件夹名或旧 country.json 第一次解析出的归属
 *   （只有一个候选时也一样）是「待确认的文件夹绑定」。预检列出「文件夹 → 地点（中文名 / 英文名）」；--apply 时有待确认的
 *   绑定就拒绝写入（退出码 2，什么都不写），加 --accept-folder-bindings 才接受：整次导入没有错误时写入 place.json
 *   （`{ "placeId": … }`，atomicJsonWrite）固定下来，此后按 id 解析，地点改名也不影响。已有 place.json 的文件夹不受影响。
 *   媒体任务（恢复中心，3C-4d 起只在新库里）在导入确认步骤里一并确认（../media-job-service.mjs）。
 * - **内容寻址**：媒体 id = media-<源文件 sha256 前 16 位>，生成文件在 media/user/<同一哈希>/。改名、搬城市、改类型
 *   都不改变 id 与路径；重复运行，目录与源文件索引除 generatedAt 外逐字节相同。
 * - **写盘**：data/v2/user-media.local.json（PR3a 的 V3 格式）与 data/v2/media-source-index.local.json，都用
 *   atomicJsonWrite。写之前，新目录放进五个 V2 文件必须通过完整性检查（每个条目的 placeId 都是注册表里的城市……），
 *   否则一个文件都不写。
 * - **生成文件的发布（第 1 批 D7）**：原图先复制、衍生图先由 sharp 写到同目录的临时文件
 *   `.<最终文件名>.<pid>.<uuid>.tmp`，fsync 后不覆盖地发布（`link` 到最终路径再删临时文件；文件系统不支持硬链接时，
 *   在库操作租约下先确认最终路径不存在再 rename）。最终路径已存在视为已经发布过。中断只会留下临时文件，不会留下
 *   截断的最终文件；下次导入在写入前删掉这些输出目录里由其他进程留下的临时文件（导入总在库操作租约下运行，
 *   所以其他进程的临时文件只可能是中断的遗留；本进程自己的临时文件由失败路径删除）。
 * - **校验（`media:check --verify`）**：对已存在的原图（目录里的条目与这次计划的条目）重算内容哈希，与目录名（哈希前缀）
 *   核对，只报告不一致（记为需要处理的问题），不自动修复。默认流程不做全量哈希。
 *
 * 可测试的部分（索引、解析、内容寻址、条目、封面）是纯函数，在 src/data/v2media/importPlan.ts。
 * 报告的格式与旧导入器相同：本地编辑器（local-editor-plugin.mjs 的 runImporter）按「需要处理」「缺少日期或分辨率」
 * 等字样判断预检是否通过。扫描的其余规则（文件夹别名、支持的格式、文件大小提醒、全景比例、sidecar 的读法）照抄旧导入器。
 */

import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import { sha256File } from '../file-hash.mjs'
import { V2_FILE_KEYS, validateV2Files } from '../../src/data/compat/v2/v2Schema.ts'
import {
  buildMediaItem,
  contentHashOf,
  createMediaPlaceIndex,
  generatedFilesOf,
  isLikelyEquirectangularPanorama,
  isStillMedia,
  markCovers,
  orientedDimensions,
  folderBindingLine,
  uniqueById,
} from '../../src/data/v2media/importPlan.ts'
import { completeForWrite } from '../../src/data/compat/v2/v2Integrity.ts'
import { toPosix, pathExists, extensionProblemOf, unlabelledDroneWarning, walkInbox } from '../media-inbox.mjs'

/** 读不出的 V2 数据文件：只报文件与类别（JSON.parse 的消息会带出原文片段）。 */
const describeReadFailure = (error) => (error instanceof SyntaxError ? '不是有效的 JSON' : error?.code ?? error?.name ?? '未知错误')

/** 读 data/v2/ 的五个文件；缺的为 undefined。 */
const readV2DataFiles = async (privatePaths) => {
  const files = {}
  for (const key of V2_FILE_KEYS) {
    const target = privatePaths.v2FilePaths[key]
    try {
      files[key] = JSON.parse(await readFile(target, 'utf8'))
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      throw new Error(`V2 数据文件 ${target} 无法读取（${describeReadFailure(error)}）。`, { cause: error })
    }
  }
  return files
}

/** 预检列出待确认绑定的标题（本地编辑器的导入器按这几个字判断预检没有通过）。 */
export const FOLDER_BINDINGS_HEADING = '待确认的文件夹绑定'
const FOLDER_BINDINGS_HINT = '确认无误后运行 npm run media:import -- --accept-folder-bindings；不对时在该文件夹里放 place.json 指定地点。'

/**
 * V2 导入的预检（只读，不写任何文件；3C-5 E 删除了写入）。返回退出码：0 通过（可能有提醒或待确认的文件夹绑定），1 有需要
 * 处理的问题或读失败。`capturePlan` 时不打印，返回计划（scanV2MediaImport）。`now` 与两个输出函数可注入（测试用）。
 */
export async function runV2MediaImport({ privatePaths, verify = false, excludeSourcePaths = [], now = () => new Date(), log = console.log, logError = console.error, capturePlan = false }) {
  const inboxRoot = privatePaths.inboxRoot
  // 彻底删除的预检（第 1 批 D5）按「删除之后」的投递箱扫描：要删的源文件不参与。只用于只读扫描。
  const sourceKey = (target) => (process.platform === 'win32' ? path.resolve(target).toLowerCase() : path.resolve(target))
  const excluded = new Set(excludeSourcePaths.map(sourceKey))
  const outputRoot = privatePaths.userMediaRoot
  const errors = []
  const warnings = []
  const advisoryWarnings = []
  const planned = []
  /**
   * 待确认的文件夹绑定：按文件夹名或旧 country.json 解析成功、还没有 place.json 的文件夹（第 2A 批）。确认之后
   * （CLI 的 --accept-folder-bindings，或媒体任务的导入确认）才写入 place.json 固定下来（RFC ID-6）。
   */
  const pins = []
  const relative = (filePath) => path.relative(inboxRoot, filePath)
  const captured = (files = {}, unique = [], items = []) => ({ privatePaths, files, planned, unique, items, pins, errors, warnings, advisoryWarnings })

  const printReport = (items) => {
    const counts = items.reduce((result, item) => {
      result[item.kind] = (result[item.kind] ?? 0) + 1
      return result
    }, {})
    log(`StarMap 媒体预检：${items.length} 个文件`)
    log(`普通照片 ${counts.photo ?? 0} | 360 全景 ${counts.panorama360 ?? 0} | 航拍照片 ${counts.aerialPhoto ?? 0} | 视频 ${counts.video ?? 0}`)
    if (warnings.length > 0) {
      log(`\n提醒（${warnings.length}）：`)
      for (const warning of warnings) log(`- ${warning}`)
    }
    if (errors.length > 0) {
      logError(`\n需要处理（${errors.length}）：`)
      for (const error of errors) logError(`- ${error}`)
    }
    if (pins.length > 0) {
      log(`\n${FOLDER_BINDINGS_HEADING}（${pins.length}）：以下文件夹按名称（或旧 country.json）匹配到地点，确认之后才会写入 place.json 并按它导入：`)
      for (const pin of pins) log(`- ${folderBindingLine(toPosix(relative(pin.directory)), pin)}`)
    }
    if (errors.length === 0) {
      log(pins.length > 0
        ? `\n预检通过，但有按名称匹配的文件夹绑定需要确认。${FOLDER_BINDINGS_HINT}`
        : '\n预检通过。确认无误后运行 npm run media:import。')
    }
  }

  // ---- 地点注册表 ----
  let files
  try {
    files = await readV2DataFiles(privatePaths)
  } catch (error) {
    errors.push(error.message)
    if (capturePlan) return captured()
    printReport([])
    return 1
  }
  const placeProblems = validateV2Files(completeForWrite(files, now())).filter((problem) => problem.file === 'places')
  if (placeProblems.length > 0) {
    errors.push(`地点注册表 ${privatePaths.v2FilePaths.places} 没有通过校验（${placeProblems.length} 处），无法解析照片归属：${placeProblems.slice(0, 5).map((problem) => `${problem.path}：${problem.message}`).join('；')}`)
    if (capturePlan) return captured(files)
    printReport([])
    return 1
  }
  const index = createMediaPlaceIndex(files.places?.places ?? [])

  // ---- 扫描（规则照抄旧导入器）----
  const validateExtension = (filePath, kind) => {
    const extension = path.extname(filePath).toLowerCase()
    const problem = extensionProblemOf(relative(filePath), kind, extension)
    if (!problem) return extension
    if (problem.error) errors.push(problem.error)
    else warnings.push(problem.warning)
    return undefined
  }

  const planFile = async ({ filePath, kind, city, metadata = {} }) => {
    if (excluded.has(sourceKey(filePath))) return
    const extension = validateExtension(filePath, kind)
    if (!extension) return

    const fileStats = await stat(filePath)
    const sizeInMiB = fileStats.size / 1024 / 1024
    const warningThreshold = kind === 'panorama360' ? 40 : kind === 'video' ? 120 : 16
    if (sizeInMiB > warningThreshold) {
      const warning = `${relative(filePath)} 为 ${sizeInMiB.toFixed(1)} MiB，建议 Agent 生成更轻的网页版本。`
      warnings.push(warning); advisoryWarnings.push(warning)
    }

    const fullHash = await sha256File(filePath)
    const hash = contentHashOf(fullHash)
    const still = isStillMedia(kind, extension)
    let dimensions
    if (still) {
      try {
        dimensions = orientedDimensions(await sharp(filePath).metadata())
      } catch (error) {
        errors.push(`${relative(filePath)} 无法读取图片尺寸：${error.message}`)
        return
      }
      if (!dimensions) {
        errors.push(`${relative(filePath)} 缺少有效的图片宽高。`)
        return
      }
      if (kind === 'panorama360' && !isLikelyEquirectangularPanorama(dimensions)) {
        errors.push(`${relative(filePath)} 是 ${dimensions.width} × ${dimensions.height}，不是常见的 2:1 等距柱状全景图；请在 media.json 中改为 aerialPhoto，或换用正确的 360 全景图。`)
        return
      }
    }

    const item = buildMediaItem({ hash, extension, kind, placeId: city.id, originalFileName: path.basename(filePath), dimensions, metadata })
    if (item.status === 'needsMetadata') {
      warnings.push(`${relative(filePath)} 缺少日期或分辨率；会进入目录，但暂不显示为 Drone Media。`)
    }
    const generated = generatedFilesOf(hash, extension)
    const outputPathOf = (relativeFile) => path.join(outputRoot, ...relativeFile.split('/'))
    planned.push({
      id: item.id,
      item,
      sha256: fullHash,
      bytes: fileStats.size,
      metadata,
      sourcePath: filePath,
      outputDirectory: outputPathOf(generated.directory),
      outputPath: outputPathOf(generated.original),
      derivatives: still
        ? generated.derivatives.map((derivative) => ({ outputPath: outputPathOf(derivative.file), maxEdge: derivative.maxEdge, quality: derivative.quality }))
        : [],
    })
  }

  // 3C-4c：遍历投递箱的规则移到 walkInbox（与新库的扫描共用），顺序、提示与错误都不变。
  await walkInbox({
    inboxRoot, index, errors, warnings, pins,
    onFile: async ({ filePath, kind, unlabelled, city, metadata }) => {
      if (unlabelled) warnings.push(unlabelledDroneWarning(relative(filePath)))
      await planFile({ filePath, kind, city, metadata })
    },
  })

  const unique = uniqueById(planned)
  if (unique.length !== planned.length) {
    const warning = `发现 ${planned.length - unique.length} 个内容完全相同的重复文件，目录中只保留一份记录。`
    warnings.push(warning); advisoryWarnings.push(warning)
  }
  const items = markCovers(unique.map((entry) => entry.item))
  if (capturePlan) return captured(files, unique, items)
  if (verify) await verifyGeneratedOriginals({ files, unique, outputRoot, errors, log })
  printReport(items)

  return errors.length > 0 ? 1 : 0
}

/**
 * `--verify`：已存在的原图（当前目录里的条目，加这次计划的条目）重算 sha256，前 16 位必须等于所在目录名。
 * 不一致记为需要处理的问题（退出码 1），不删除、不重写任何文件。
 */
async function verifyGeneratedOriginals({ files, unique, outputRoot, errors, log }) {
  const originals = new Map()
  for (const item of Array.isArray(files.media?.items) ? files.media.items : []) {
    const match = typeof item?.src === 'string' && /^\/media\/user\/([a-f0-9]{16})\/(original\.[a-z0-9]+)$/.exec(item.src)
    if (match) originals.set(path.join(outputRoot, match[1], match[2]), match[1])
  }
  for (const entry of unique) originals.set(entry.outputPath, path.basename(entry.outputDirectory))
  let checked = 0
  for (const [target, expected] of originals) {
    if (!(await pathExists(target))) continue
    checked += 1
    const actual = (await sha256File(target)).slice(0, 16)
    if (actual !== expected) {
      errors.push(`生成的原图 media/user/${expected}/${path.basename(target)} 与目录名的内容哈希不一致（实际为 ${actual}），可能被截断或改动。确认后删除这个生成目录，再运行 npm run media:import 重新生成。`)
    }
  }
  log(`校验：核对了 ${checked} 张已生成原图的内容哈希。`)
}

/** The CLI and durable task planner share exactly one Inbox scanner. Never writes. */
export const scanV2MediaImport = (options) => runV2MediaImport({ ...options, capturePlan: true })
