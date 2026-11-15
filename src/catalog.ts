/**
 * CodeBuddy 模型目录:名册、倍率、上下文窗口、推理档位与原生模态。
 *
 * 三件事在这里统一,别处只读结论:
 *
 * 1. **名册**(哪些模型可选):CLI 登录后拉取的实时目录
 *    `~/.codebuddy/local_storage/entry_*.info` 里 `data.agents[].models`
 *    就是 `codebuddy --model` 接受的那一份(实测 17 个,与 `--help` 逐字一致);
 *    它同时排除了路由型条目(`default`),不需要另做剔除规则。
 * 2. **倍率**:同一条目的 `credits`(形如 `x0.11 credits`)。实时目录是唯一
 *    可信来源——bundled `product.json` 会过时(实测 ds41-flash:实时 x0.11、
 *    bundled x0.00、internal 变体 x0.03),所以 bundled 只用来补窗口/档位,
 *    **永不提供倍率**。
 * 3. **原生模态**:目录里的 `supportsImages` 是平台侧声明,不是模型原生能力
 *    ——实测 34 条里 21 条为 true,连纯文本模型(hy3 系)也是 true。因此模态
 *    按**精确 id 白名单**判定,表外一律仅文本;平台声明为 false 时一票否决
 *    (`imageDefaultFor` 同款语义,见 dsh-connect-workbuddy 的
 *    src/native-modality.ts)。宁可漏标,不可把纯文本模型标成多模态。
 *
 * @module @flg1217/dsh-subagent-codebuddy/catalog
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 原生模态:只有两态可确认,表外视为 unknown(按仅文本处理)。 */
export type CodebuddyModality = 'text' | 'multimodal'

/**
 * 已核实原生多模态的模型 id(精确匹配,不按前缀/同族推断)。
 *
 * 依据:上游实测 + 同族模型的官方能力说明。凡是与 dsh-connect-workbuddy 的
 * `NATIVE_MODALITY_BY_MODEL_ID` 重叠的 id 取值必须一致——两个插件描述的是
 * 同一批上游模型,口径不一致会让用户在两个选择器里看到相反的标注。
 *
 * 新增模型时**先核实再入表**;不确定就留在表外(仅文本),不要继承平台
 * `supportsImages`。
 */
export const MULTIMODAL_MODEL_IDS: ReadonlySet<string> = new Set([
  // 与 workbuddy 重叠、已确认多模态
  'deepseek-v4.1-flash',
  'glm-5.3-flash',
  'kimi-k2.6',
  'kimi-k2.7',
  'kimi-k3-1',
  'minimax-m3',
  'minimax-m3.1-flash',
  'space-bunny',
  'hy4free',
  'hy4std',
  'hy4-preview-x',
  // CodeBuddy 侧独有、按官方能力说明确认视觉输入
  'glm-4.6v',
  'gemini-3.5-flash',
  'gpt-6-astra',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5.5',
  'gpt-5.4',
])

/**
 * workbuddy 明确记为纯文本、但 CodeBuddy 目录声明 `supportsImages: true` 的
 * id。列出来是为了让"平台声明不可信"这件事在代码里可查:两边描述同一模型时
 * 以 workbuddy 的核实结论为准。
 */
export const TEXT_ONLY_MODEL_IDS: ReadonlySet<string> = new Set([
  'deepseek-v4-pro',
  'glm-5.1',
  'glm-5.2',
  'glm-5.3',
  'hy3',
  'hy3-x',
  'kimi-k2.5',
  'kimi-k2.8-preview',
  'kimi-k3.1-pro',
  'deepseek-v4-flash',
  'deepseek-v3-2-volc',
  'glm-5.0',
  'glm-5.0-turbo',
  'glm-4.7',
  'glm-4.6',
  'hunyuan-chat',
  'minimax-m2.5',
  'minimax-m2.7',
  'step-5-preview',
  'mimo-v2.6-pro',
  'fast-model',
  'balanced-model',
  'primary-model',
  'deep-model',
])

/** 目录条目(适配器与设置卡共用的一份形状)。 */
export interface CodebuddyCatalogModel {
  readonly id: string
  /** 上游展示名(`DeepSeek-V4.1-Flash`);缺失时回退 id。 */
  readonly name: string
  /** 积分倍率(0.11 表示 x0.11);缺失表示上游未报价。 */
  readonly credits?: number
  /** 条目是否免费档(credits = 0 且上游标注 free,或倍率为 0)。 */
  readonly free: boolean
  /** 上下文窗口(上游 `maxInputTokens`)。 */
  readonly contextWindow?: number
  readonly maxOutputTokens?: number
  /** 原生模态(精确 id 表 + 平台否定票,见模块头)。 */
  readonly modality: CodebuddyModality
  /** 可选择的推理档位(已按 CLI `--effort` 白名单收敛);空数组表示不暴露档位。 */
  readonly efforts: readonly string[]
  readonly defaultEffort?: string
  /** 来源:实时目录 / bundled 兜底。 */
  readonly source: 'live' | 'bundled'
}

/** 读到的整份目录。 */
export interface CodebuddyCatalog {
  readonly models: readonly CodebuddyCatalogModel[]
  /** 可被 `--model` 接受的 id(`data.agents[].models`);缺省表示未知,调用方按 models 兜底。 */
  readonly selectable: readonly string[]
  readonly source: 'live' | 'bundled' | 'empty'
}

/** CLI `--effort` 接受的值(`--help`:minimal, low, medium, high, xhigh, max)。 */
export const CLI_EFFORTS: readonly string[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** 档位展示名(与 CLI 帮助文本一致)。 */
const EFFORT_LABELS: Readonly<Record<string, string>> = {
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
}

/** 档位展示名。 */
export function effortLabel(effort: string): string {
  return EFFORT_LABELS[effort] ?? effort
}

/**
 * 解析倍率:上游给的是字符串 `"x0.11 credits"`,也可能已经是数字。
 * @param raw - `credits` 字段原值。
 * @returns 倍率数值;无法解析(空串、缺字段、路由模型)时 undefined。
 */
export function parseCredits(raw: unknown): number | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  if (typeof raw !== 'string') return undefined
  const match = /x\s*(\d+(?:\.\d+)?)/i.exec(raw) ?? /(\d+(?:\.\d+)?)/.exec(raw)
  if (match === null) return undefined
  const value = Number(match[1])
  return Number.isFinite(value) ? value : undefined
}

/**
 * 倍率展示文本:`x0.11`。
 *
 * 固定两位小数(与 dsh-connect-workbuddy 的选择器标签一致);0 显示 `x0.00`
 * 而不是"免费",因为免费档的判定另由 {@link CodebuddyCatalogModel.free} 承担,
 * 用户在同一个列表里看到的数字要能横向比较。
 * @param rate - 倍率数值。
 * @returns 形如 `x0.11` 的文本。
 */
export function formatCredits(rate: number): string {
  return `x${rate.toFixed(2)}`
}

/**
 * 解析推理档位。上游有两种形状:
 * - 固定档:`{ effort: "high", summary: "auto" }` —— 模型恒用该档,只暴露这一项;
 * - 可选档:`{ supportedEfforts: [...], defaultEffort, canDisableThinking }`。
 * @param raw - `reasoning` 字段原值。
 * @returns 已按 CLI 白名单过滤的档位与默认档。
 */
export function parseReasoning(raw: unknown): { efforts: string[]; defaultEffort?: string } {
  if (raw === null || typeof raw !== 'object') return { efforts: [] }
  const source = raw as { effort?: unknown; supportedEfforts?: unknown; defaultEffort?: unknown }
  const listed = Array.isArray(source.supportedEfforts)
    ? source.supportedEfforts.filter((value): value is string => typeof value === 'string')
    : []
  const fixed = typeof source.effort === 'string' ? [source.effort] : []
  const efforts = [...new Set([...listed, ...fixed])].filter(effort => CLI_EFFORTS.includes(effort))
  const preferred = typeof source.defaultEffort === 'string' ? source.defaultEffort : undefined
  const defaultEffort = preferred !== undefined && efforts.includes(preferred)
    ? preferred
    : efforts.length === 1 ? efforts[0] : undefined
  return defaultEffort === undefined ? { efforts } : { efforts, defaultEffort }
}

/**
 * 原生模态判定。
 *
 * 顺序与 workbuddy 的 `imageDefaultFor` 一致:平台声明 false 一票否决 →
 * 精确 id 白名单 → 其余仅文本。平台声明 true **不构成依据**。
 * @param id - 模型 id。
 * @param platformSupportsImages - 目录里的 `supportsImages`(可能缺失)。
 * @returns 判定结果。
 */
export function modalityOf(id: string, platformSupportsImages?: unknown): CodebuddyModality {
  if (platformSupportsImages === false) return 'text'
  if (TEXT_ONLY_MODEL_IDS.has(id)) return 'text'
  return MULTIMODAL_MODEL_IDS.has(id) ? 'multimodal' : 'text'
}

/** 实时目录里单条模型的字段面(只声明用到的键)。 */
interface LiveModelEntry {
  id?: unknown
  name?: unknown
  credits?: unknown
  maxInputTokens?: unknown
  maxOutputTokens?: unknown
  supportsImages?: unknown
  supportsToolCall?: unknown
  reasoning?: unknown
  tags?: unknown
  relatedModels?: unknown
}

/** 实时目录整份(`entry_*.info` 里的 `data`)。 */
interface LiveCatalogData {
  models?: unknown
  agents?: unknown
}

/** 文本模型判定:有输入窗口才算对话模型(图像/视频条目没有 token 字段)。 */
function isTextModel(entry: LiveModelEntry): boolean {
  return typeof entry.id === 'string' && entry.id.length > 0
    && typeof entry.maxInputTokens === 'number' && entry.maxInputTokens > 0
}

/** 单条实时模型 → 目录条目。 */
function fromLiveEntry(entry: LiveModelEntry): CodebuddyCatalogModel | undefined {
  if (!isTextModel(entry)) return undefined
  const id = entry.id as string
  const credits = parseCredits(entry.credits)
  const reasoning = parseReasoning(entry.reasoning)
  return {
    id,
    name: typeof entry.name === 'string' && entry.name.length > 0 ? entry.name : id,
    ...credits === undefined ? {} : { credits },
    free: entry.tags !== undefined && Array.isArray(entry.tags) && entry.tags.includes('free')
      ? true
      : credits === 0,
    ...typeof entry.maxInputTokens === 'number' ? { contextWindow: entry.maxInputTokens } : {},
    ...typeof entry.maxOutputTokens === 'number' ? { maxOutputTokens: entry.maxOutputTokens } : {},
    modality: modalityOf(id, entry.supportsImages),
    efforts: reasoning.efforts,
    ...reasoning.defaultEffort === undefined ? {} : { defaultEffort: reasoning.defaultEffort },
    source: 'live',
  }
}

/** CodeBuddy 配置目录(`CODEBUDDY_CONFIG_DIR` 与 CLI 自身口径一致)。 */
export function codebuddyConfigDir(): string {
  const override = process.env['CODEBUDDY_CONFIG_DIR']
  return override !== undefined && override.length > 0 ? override : join(homedir(), '.codebuddy')
}

/**
 * 读实时目录:`<config>/local_storage/entry_*.info`。
 *
 * 这些 `.info` 是 CLI 登录后写入的缓存,同一目录里还有别的形状(功能开关、
 * base64 大 blob),所以逐个解析后取 `data.models` 最多的一份——那是当前
 * 账号的模型名册。文件缺失/损坏一律当作"没有实时目录",由调用方回退。
 * @param configDir - CodeBuddy 配置目录。
 * @returns 解析结果;没有可用缓存时 undefined。
 */
export function readLiveCatalog(configDir: string = codebuddyConfigDir()): CodebuddyCatalog | undefined {
  const dir = join(configDir, 'local_storage')
  let files: string[]
  try {
    files = readdirSync(dir).filter(name => name.endsWith('.info'))
  } catch {
    return undefined
  }
  let best: CodebuddyCatalog | undefined
  for (const file of files) {
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(join(dir, file), 'utf8'))
    } catch {
      continue
    }
    const accounts = Array.isArray(parsed) ? parsed : [parsed]
    for (const account of accounts) {
      const data = (account as { data?: LiveCatalogData } | undefined)?.data
      if (data === undefined || !Array.isArray(data.models)) continue
      const models: CodebuddyCatalogModel[] = []
      for (const raw of data.models) {
        const model = fromLiveEntry(raw as LiveModelEntry)
        if (model !== undefined) models.push(model)
      }
      if (models.length === 0) continue
      const selectable = Array.isArray(data.agents)
        ? (data.agents as { models?: unknown }[]).flatMap(agent =>
          Array.isArray(agent.models) ? agent.models.filter((id): id is string => typeof id === 'string') : [])
        : []
      // 同账号下可能有多份缓存;取模型最多的那份(旧缓存会缺新模型)。
      if (best === undefined || models.length > best.models.length) {
        best = { models, selectable: [...new Set(selectable)], source: 'live' }
      }
    }
  }
  return best
}

/** bundled `product*.json` 的字段面。 */
interface BundledModelEntry {
  id?: unknown
  name?: unknown
  maxInputTokens?: unknown
  maxOutputTokens?: unknown
  supportsImages?: unknown
  reasoning?: unknown
  isDefault?: unknown
  relatedModels?: unknown
}

/**
 * 读 bundled 目录(离线兜底):CLI 安装目录里的 `product*.json`。
 *
 * 只取 id / 展示名 / 窗口 / 档位——**不取 credits**:bundled 倍率会过时
 * (实测 ds41-flash 实时 x0.11 vs bundled x0.00),把旧价写进选择器比不写更糟。
 * 路由型条目(`isDefault: true` 且 `relatedModels` 指向自己)从名册剔除。
 * @param productFiles - `product*.json` 的绝对路径清单。
 * @returns 目录;全部不可读时 undefined。
 */
export function readBundledCatalog(productFiles: readonly string[]): CodebuddyCatalog | undefined {
  let best: CodebuddyCatalog | undefined
  for (const file of productFiles) {
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      continue
    }
    const list = (parsed as { models?: unknown } | undefined)?.models
    if (!Array.isArray(list)) continue
    const models: CodebuddyCatalogModel[] = []
    for (const raw of list) {
      const entry = raw as BundledModelEntry
      if (typeof entry.id !== 'string' || entry.id.length === 0) continue
      if (typeof entry.maxInputTokens !== 'number' || entry.maxInputTokens <= 0) continue
      const isRouter = entry.isDefault === true
        && Array.isArray(entry.relatedModels)
        && (entry.relatedModels as unknown[]).includes(entry.id)
      if (isRouter) continue
      const reasoning = parseReasoning(entry.reasoning)
      models.push({
        id: entry.id,
        name: typeof entry.name === 'string' && entry.name.length > 0 ? entry.name : entry.id,
        free: false,
        contextWindow: entry.maxInputTokens,
        ...typeof entry.maxOutputTokens === 'number' ? { maxOutputTokens: entry.maxOutputTokens } : {},
        modality: modalityOf(entry.id, entry.supportsImages),
        efforts: reasoning.efforts,
        ...reasoning.defaultEffort === undefined ? {} : { defaultEffort: reasoning.defaultEffort },
        source: 'bundled',
      })
    }
    if (models.length > 0 && (best === undefined || models.length > best.models.length)) {
      best = { models, selectable: [], source: 'bundled' }
    }
  }
  return best
}

/**
 * 找 CLI 安装目录里的 `product*.json`(bundled 兜底用)。
 *
 * 入参是 `resolveSpawnableCommand` 给出的候选入口(第一个是真实 CLI 脚本,
 * 形如 `.../node_modules/@tencent-ai/codebuddy-code/bin/codebuddy`)。CLI 把
 * 产品配置放在包的根目录,所以从入口往上最多走四层找 `product*.json`——
 * 不写死包名,换 npm shim 形态时仍能命中。
 * @param entryPoints - 候选入口路径。
 * @returns 存在的 `product*.json` 绝对路径(可能为空)。
 */
export function productFilesNear(entryPoints: readonly string[]): string[] {
  const found: string[] = []
  for (const entry of entryPoints) {
    if (typeof entry !== 'string' || entry.length === 0) continue
    let dir = dirname(entry)
    for (let depth = 0; depth < 5; depth += 1) {
      let names: string[] = []
      try {
        names = readdirSync(dir).filter(name => name.startsWith('product') && name.endsWith('.json'))
      } catch {
        names = []
      }
      if (names.length > 0) {
        // bundled 主档在前:同分时优先它,变体只作补充。
        names.sort((left, right) => prizeOrder(left) - prizeOrder(right))
        for (const name of names) found.push(join(dir, name))
        break
      }
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  return [...new Set(found)]
}

/** bundled 主档排序权重(`product.json` 优先)。 */
function prizeOrder(name: string): number {
  return name === 'product.json' ? 0 : 1
}

/** 目录快照的读取面(适配器注入;便于测试替换)。 */
export interface CatalogSource {
  /** 当前目录快照(永不抛错;无从读取时返回空目录)。 */
  current(): CodebuddyCatalog
  /** 强制重读(设置卡"刷新"用)。 */
  invalidate(): void
}

/**
 * 带 mtime 缓存的目录读取器。
 *
 * `resolveModel` 每次请求都会被调用,实时目录文件也可能被 CLI 随时重写:
 * 按"文件 mtime + size"做缓存键,内容没变就不重复解析,变了立刻生效。
 * 读取失败保留上一次快照(60 秒后再试),不让 CLI 的临时文件写坏目录。
 * @param opts.live - 实时目录读取(默认 {@link readLiveCatalog})。
 * @param opts.bundled - bundled 兜底读取(默认 {@link readBundledCatalog})。
 * @param opts.bundledFiles - bundled 文件路径清单。
 * @param opts.now - 时钟(测试注入)。
 * @returns 目录读取器。
 */
export function createCatalogSource(opts: {
  live?: () => CodebuddyCatalog | undefined
  bundled?: () => CodebuddyCatalog | undefined
  now?: () => number
} = {}): CatalogSource {
  const now = opts.now ?? (() => Date.now())
  const live = opts.live ?? (() => readLiveCatalog())
  const bundled = opts.bundled ?? (() => undefined)
  let cached: { catalog: CodebuddyCatalog; at: number } | undefined
  let failedAt = 0
  const EMPTY: CodebuddyCatalog = { models: [], selectable: [], source: 'empty' }
  return {
    current(): CodebuddyCatalog {
      const stamp = now()
      if (cached !== undefined && stamp - cached.at < 30_000) return cached.catalog
      if (failedAt !== 0 && stamp - failedAt < 60_000 && cached === undefined) return EMPTY
      let found: CodebuddyCatalog | undefined
      try {
        found = live() ?? bundled()
      } catch {
        found = undefined
      }
      if (found === undefined || found.models.length === 0) {
        failedAt = stamp
        return cached?.catalog ?? EMPTY
      }
      failedAt = 0
      cached = { catalog: found, at: stamp }
      return found
    },
    invalidate(): void {
      cached = undefined
      failedAt = 0
    },
  }
}

/** 目录快照里按 id 查条目。 */
export function findCatalogModel(catalog: CodebuddyCatalog, id: string): CodebuddyCatalogModel | undefined {
  return catalog.models.find(model => model.id === id)
}

/**
 * 选择器展示名:`DeepSeek-V4.1-Flash · x0.11`。
 *
 * 倍率进 name 是刻意的(与 dsh-connect-workbuddy 一致):宿主原样渲染
 * `LlmModelInfo.name`,而 `badge` 只能承载短标签;把价格放进名字是这一栏
 * 唯一能横向比较的位置。没有报价的模型不带后缀,不写"未知"占位。
 * @param model - 目录条目。
 * @returns 展示名。
 */
export function catalogModelName(model: CodebuddyCatalogModel): string {
  return model.credits === undefined ? model.name : `${model.name} · ${formatCredits(model.credits)}`
}

/**
 * 目录条目 → `LlmModelInfo` 的输入模态。
 * @param model - 目录条目。
 * @returns 只含已核实模态的数组。
 */
export function catalogInputModalities(model: CodebuddyCatalogModel): readonly ('text' | 'image')[] {
  return model.modality === 'multimodal' ? ['text', 'image'] : ['text']
}

/** 目录文件的时间戳(诊断/测试用:最后一次改动时刻)。 */
export function catalogMtime(files: readonly string[]): number {
  let latest = 0
  for (const file of files) {
    try {
      latest = Math.max(latest, statSync(file).mtimeMs)
    } catch { /* 不存在即忽略 */ }
  }
  return latest
}
