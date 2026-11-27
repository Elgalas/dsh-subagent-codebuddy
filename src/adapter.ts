/**
 * CodeBuddy 模型适配器:provider 路由 `codebuddy`,走 ACP(Agent Client Protocol)。
 *
 * 两条路径(路线 C1 起):
 *
 * 1. **回合泵**(`src/pump.ts`):会话绑定且调用方(agent-loop)已打开 step
 *    的对话轮。一个 CodeBuddy 回合 = 一个 ACP 进程,按**模型调用**切段,
 *    每个 dsh step 消费一段;工具调用注册 per-agent 的回放工具、由 loop
 *    原生写 `assistant/message` / `tool/call` / `tool/result`——适配器自己
 *    零会话写入。这样「一次模型调用 = 一个 step」与 dsh 语义一致:文本/工具
 *    顺序、每步用量、分页、客户端末条胜出渲染全部自然成立。
 * 2. **一次性旁路会话**(压缩/会话标题等 purpose 调用、无会话调用):
 *    纯 chunk 流,零写入。
 *
 * ACP 层的关键机制(两条路径共用):
 * - **会话生命周期官方化**:`session/new` / `session/load`(历史回放)复用
 *   长线会话;`session/prompt` 流式 `session/update`(含 thinking 流);
 * - **协议级取消**:`session/cancel` 对生成流与正在执行的工具都是即时抢占
 *   (实测),abort 信号驱动周期性重发(思考早期单次通知可能被吞);
 * - **静默失败自动重试**:CodeBuddy 服务端偶发静默失败(实测高频)——
 *   end_turn 但零思考零文本零工具。泵在首段无产出时重启一次(恢复同一
 *   会话续跑);已有产出的回合以显式错误收尾;
 * - **假死防御分层**:进展性 update(消息/思考/工具)重置动态空闲阈值;
 *   CLI 心跳(session_info/usage/config)与 stderr 不参与续命;静默超
 *   阈值先发 cancel、5s 仍无响应才 kill——进程退出码与 stderr 全程留证。
 * @module subagent-codebuddy/adapter
 */

import type { Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { steerDebug } from './steer-debug.js'
import { ReasoningEffortId, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, ModelModality, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { ConversationStore } from './conversations.js'
import { conversationFilePath, messagesToRecords, uuidv7, writeConversationFile } from './native-session.js'
import type { NativeRecord } from './native-session.js'
import type { DshSurfaceTool } from '@elgalas/dsh-mcp-tool-server'
import { buildPrompt, lastUserPrompt, resumeReplayPrompt, systemInstructionsText } from './serialize.js'
import { TodoListState } from './todo-bridge.js'
import { AttachmentsSaveFace } from './tool-image.js'
import { AcpConnection, DEFAULT_ACP_RUN_TIMEOUTS, cliToolPolicyArgs, isProgressUpdate, isPtcOnlySurface, usageOfUpdate } from './acp.js'
import { mcpConfigArgs } from './mcp-config.js'
import { registerDshMcpServer } from '@elgalas/dsh-mcp-tool-server'
import type { AcpPromptResult, AcpTimeouts, AcpUpdate } from './acp.js'
import { failureOfError, formatFailureLine, isFailureOutcome, isMissingAcpSession, parseCodebuddyFailure } from './failure.js'
import type { CodebuddyFailure } from './failure.js'
import { TurnPump } from './pump.js'
import { createModelPlan } from './model-plan.js'
import { syncSkillsToCodebuddy } from './cli-integrations.js'
import type { ImageReadGuidance, PumpHost } from './pump.js'
import { listCodebuddyModelIdsAsync } from './models.js'
import { createModelCapabilityIndex } from './model-capabilities.js'
import type { ModelCapabilityIndex } from './model-capabilities.js'
import {
  catalogInputModalities,
  catalogModelName,
  effortLabel,
  createCatalogSource,
  findCatalogModel,
  productFilesNear,
  readBundledCatalog,
  readLiveCatalog,
} from './catalog.js'
import type { CatalogSource } from './catalog.js'

/**
 * dsh system prompt 的版本哈希(16 位十六进制)。
 *
 * dsh 默认**每个请求**都带当前 system prompt,其内容会随工具注册/设置/
 * 工作区指令/技能目录等变化;CLI 侧是持久历史,所以按"首次随 seed 或首包
 * 发送 + 内容变化时补发"实现等价语义(见 startTurn)。哈希记在续接记录里,
 * 重启后不会重复灌已发过的版本。
 *
 * 读图引导(guidance)随路由模型的能力变化,且它就嵌在 system 块末尾
 * (serialize 的 toolRoutingNote)——纳入哈希,模型热切换后 system 块补发
 * 一次,CLI 侧拿到与新模型匹配的读图指路。
 * @param system - system prompt 全文。
 * @param guidance - 读图引导档位(见 {@link ImageReadGuidance})。
 * @returns 哈希;system 为空时 undefined。
 */
function systemHashOf(system: string | undefined, guidance: ImageReadGuidance = 'native'): string | undefined {
  if (system === undefined || system.trim().length === 0) return undefined
  return createHash('sha256').update(`${system}\u0000${guidance}`).digest('hex').slice(0, 16)
}

/** dsh tools 服务的最小面(按名取工具;缺席视为未注册)。 */
interface ToolsServiceFace {
  get?: (name: string, scope?: unknown) => unknown
}

/**
 * 读图引导档位的纯判定(与 ctx、能力索引解耦,便于单测)。
 *
 * **非 PTC 恒 native**:CLI 的 `--tools` 白名单固定放行 `Read,ViewImage`
 * (acp.ts 的 `cliToolPolicyArgs`),ViewImage 走 CLI 自己的读图管线、不受
 * "MCP 工具结果的图片按模型能力过滤"的限制——读图能力由 CLI 策略决定,
 * 与 dsh 工具注册表无关(注册表在宿主平面,工具按 agent 作用域挂载,子代理
 * 会话查不到 `read_image`)。**PTC 例外**:`--tools ''` 禁掉 ViewImage,
 * 只能走程序里的 `tools.read_image`,故按在场情况分级。
 * @param facts - 判定所需事实(见各字段)。
 * @returns 读图引导档位。
 */
export function imageGuidanceFrom(facts: {
  /** 本 step 的工具面是否就是 PTC 的 `run_code` 单工具面。 */
  readonly ptcOnly: boolean
  /** dsh 侧 `read_image` 是否已注册(子代理作用域下宿主平面看不到)。 */
  readonly readImage: boolean
  /** dsh 侧 `read_image_agy` 是否已注册(AGY 转述)。 */
  readonly agy: boolean
  /** tools 服务是否缺席(极简/测试上下文)。 */
  readonly toolsUnavailable: boolean
  /** 模型是否原生支持图片输入(仅在 tools 服务缺席时兜底)。 */
  readonly modelImageCapable: boolean
}): ImageReadGuidance {
  if (!facts.ptcOnly) return 'native'
  if (facts.readImage || (facts.toolsUnavailable && facts.modelImageCapable)) return 'native'
  return facts.agy ? 'agy' : 'unavailable'
}

/** purpose 调用的隔离工作目录(懒建;一次性旁路会话不落进用户项目)。 */
function purposeWorkDir(): string {
  const dir = join(tmpdir(), 'codebuddy-duty')
  mkdirSync(dir, { recursive: true })
  return dir
}

/** 可重试的委托失败:恢复同一会话续跑(ACP session/load)即可,不重复已完成部分。 */
class RetryableError extends Error {}

/** 取第一个非空字符串。 */
function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (value !== undefined && value.length > 0) return value
  }
  return undefined
}

/**
 * 按失败分类收尾:可重试分类(网络/模型服务等瞬时故障)抛 RetryableError,
 * 外层恢复会话续跑;配额/认证等重试无意义的分类直接显式中止——让对话里
 * 显示真实中断原因,而不是笼统的"静默失败"。
 */
function throwFailure(prefix: string, failure: CodebuddyFailure | undefined, suffix?: string): never {
  if (failure === undefined) throw new Error(`${prefix}未知错误`)
  const message = `${prefix}${formatFailureLine(failure, suffix)}`
  if (failure.retryable) throw new RetryableError(message)
  throw new Error(message)
}

/** listModels 成功缓存时长。 */
const SUCCESS_TTL_MS = 10 * 60_000
/** listModels 失败缓存时长(CLI 缺失/挂起时避免每次目录拉取都 spawn)。 */
const FAILURE_TTL_MS = 60_000

/**
 * CodeBuddy CLI `--effort` 支持的推理强度档位(与 TUI 的 Effort 选择器一致,
 * 顺序即选择器展示顺序:从 Faster 到 Smarter)。
 * 暴露给 dsh 的模型元数据,选中后每次调用以 `--effort <level>` 传给 CLI。
 */
const CODEBUDDY_EFFORTS: ReadonlyArray<{ level: string; name: string; description: string }> = [
  { level: 'low', name: 'Low', description: '低推理强度(--effort low)' },
  { level: 'medium', name: 'Medium', description: '中推理强度(--effort medium)' },
  { level: 'high', name: 'High', description: '高推理强度(--effort high)' },
  { level: 'xhigh', name: 'XHigh', description: '极高推理强度(--effort xhigh)' },
  { level: 'max', name: 'Max', description: '最大推理强度(--effort max)' },
  { level: 'ultracode', name: 'Ultracode', description: 'XHigh + 工作流(--effort ultracode)' },
]

/** 会话面(泵宿主用:cwd/会话元信息/事件折叠/todo 快照写入)。 */
interface TurnSessionFace {
  header: {
    cwd?: string
    parentSession?: string
    origin?: string
    delegationDepth?: number
    agentPreset?: string
  }
  ownEvents?: () => readonly { type: string; data?: unknown }[]
  append?: (type: string, data: unknown, opts?: unknown) => unknown
}

/**
 * 会话中最后一个已打开(尚无配对 step/end)的 turn/step。
 *
 * 它是「调用方是 agent-loop 的对话轮」的判据:只有这种调用才走回合泵
 * (路线 C1,一个 CodeBuddy 回合 = 多个原生 step);压缩/标题这类旁路调用
 * 没有打开 step,走一次性会话。
 * @param events - 会话自身的已提交事件(ownEvents)。
 * @returns 打开的 turn/step,没有则为 undefined。
 */
export function findOpenStep(events: readonly SessionEvent[]): { turn: number; step: number } | undefined {
  let open: { turn: number; step: number } | undefined
  for (const event of events) {
    if (event.type === 'step/start') {
      open = { turn: event.data.turn, step: event.data.step }
    } else if (event.type === 'step/end' && open !== undefined
      && event.data.turn === open.turn && event.data.step === open.step) {
      open = undefined
    }
  }
  return open
}

/** CodeBuddy CLI 入口配置(由 index.ts 解析)。 */
export interface CodebuddyAdapterOptions {
  /** 可执行入口(node 脚本绝对路径或命令)。 */
  command: string
  /** 前置参数(如解析出的 CLI 路径)。 */
  prefixArgs: string[]
  /** 读取当前默认模型(调用时求值,设置面板改默认模型后对新请求实时生效)。 */
  modelOf: () => string
  /**
   * 模型优先顺序(设置里的完整列表,第一项是默认模型)。配额/限流失败且
   * 本回合尚无产出时,回合泵按此顺序换下一个模型重开 CLI 会话。
   */
  modelFallbacksOf?: () => readonly string[]
  /** 配额/限流失败时是否允许自动换模型(默认 true)。 */
  fallbackOnQuotaOf?: () => boolean
  /** 子代理默认思考强度('' = 不传 `--effort`)。 */
  defaultEffortOf?: () => string
  /** 传给 `--permission-mode` 的权限模式。 */
  permissionMode: string
  /** 追加的额外 CodeBuddy 参数。 */
  extraArgs: string[]
  /**
   * 工具桥接模式(默认 `mcp`):mcp = spawn 加 `--mcp-config` 连 dsh 的
   * HTTP MCP server;delegate = 旧 DelegateTool 通道(不加该参数)。
   */
  bridgeMode?: 'mcp' | 'delegate'
  bridgeModeOf?: () => 'mcp' | 'delegate'
  /** 动态空闲超时预算(可选,默认见 {@link DEFAULT_ACP_RUN_TIMEOUTS})。 */
  timeouts?: AcpTimeouts
  /** 静默失败自动重试次数(默认 2:首次 + 1 次续跑)。 */
  maxAttempts?: number
  /** 重试间隔(毫秒,默认 3s)。 */
  retryDelayMs?: number
  /** 中途插入轮询间隔(毫秒,默认 1200;测试用小值)。 */
  steerPollMs?: number
  /** 续接映射存储(默认持久化到 `~/.dsh/codebuddy/conversations.json`;测试传纯内存)。 */
  store?: ConversationStore
  /** 原生会话文件根目录(默认 `~/.codebuddy/projects`;测试注入临时目录)。 */
  nativeBaseDir?: string
  /**
   * 模型能力索引(默认读 `<configDir>/models.json` 的 `supportsImages`;
   * 测试注入假索引,避免读真实 `~/.codebuddy`)。
   */
  capabilities?: ModelCapabilityIndex
  /**
   * 模型目录来源(名册/倍率/窗口/档位/原生模态)。默认读 CLI 实时目录,
   * bundled `product*.json` 只作离线兜底;测试注入固定快照。
   */
  catalog?: CatalogSource
}

/**
 * CodeBuddy 模型适配器。stream() 每次调用:
 * spawn `codebuddy --acp` → initialize → session/new(或 session/load 复用)
 * → session/prompt → 消费 session/update(思考/文本/工具)→ finish 收尾。
 * 每次调用一个 ACP 进程,用完退出;会话连续性由 CodeBuddy 会话存储 +
 * session/load 保证(实测回放完整);续接映射持久化,服务重启后自动恢复;
 * 静默失败自动恢复会话续跑。
 */
export class CodebuddyLlmAdapter extends LlmAdapter {
  /**
   * dsh 会话 → CodeBuddy ACP 会话的续接映射(持久化,跨服务重启恢复)。
   *
   * 首次调用 `session/new` 建立并记录;之后同一会话的每次 stream 都
   * `session/load` 载入同一会话(官方实现会先回放历史事件,回放不落地)。
   */
  private readonly conversations: ConversationStore

  /** listModels 缓存与并发合并(目录拉取热路径)。 */
  private modelCache: { models: readonly LlmModelInfo[]; at: number } | undefined
  private modelFetch: Promise<readonly LlmModelInfo[]> | undefined

  /** 中继回退:同一会话最多保留的转发 id 数(防无界增长)。 */
  private static readonly FORWARDED_CAP = 256

  /** dsh 会话 → todo 列表状态(CodeBuddy 任务工具折算整表快照,跨轮复用)。 */
  private readonly todoStates = new Map<string, TodoListState>()

  /** dsh 会话 → 已转发的插入消息 id(续聊补发时跳过,防重复)。 */
  private readonly forwardedInsertions = new Map<string, Set<string>>()

  /** dsh attachments 服务面(单图入库;原生 read_image 同法)。 */
  private attachmentsFace(): AttachmentsSaveFace | undefined {
    return (this.ctx as unknown as { get?: (key: string) => unknown }).get?.('attachments') as AttachmentsSaveFace | undefined
  }

  /** 标记一条插入为已转发;已标记过返回 false。 */
  private markForwarded(sessionId: string, id: string): boolean {
    let set = this.forwardedInsertions.get(sessionId)
    if (set === undefined) {
      set = new Set()
      this.forwardedInsertions.set(sessionId, set)
    }
    if (set.has(id)) return false
    set.add(id)
    while (set.size > CodebuddyLlmAdapter.FORWARDED_CAP) {
      const first = set.values().next().value
      if (first === undefined) break
      set.delete(first)
    }
    return true
  }

  /** 查询一条插入是否已投递过。 */
  private isForwarded(sessionId: string, id: string): boolean {
    return this.forwardedInsertions.get(sessionId)?.has(id) ?? false
  }

  /** 撤销一条转发标记(投递确认失败时回滚,留给补发路径)。 */
  private unmarkForwarded(sessionId: string, id: string): void {
    this.forwardedInsertions.get(sessionId)?.delete(id)
  }

  /** 模型图片能力索引(`models.json` 的 `supportsImages`;未知按仅文本)。 */
  private readonly capabilities: ModelCapabilityIndex

  /** 模型目录来源(实时名册/倍率/窗口/档位/模态)。 */
  private readonly catalog: CatalogSource

  constructor(
    private readonly ctx: Context,
    private readonly options: CodebuddyAdapterOptions,
  ) {
    super()
    this.conversations = options.store ?? new ConversationStore()
    this.capabilities = options.capabilities ?? createModelCapabilityIndex()
    this.catalog = options.catalog ?? createCatalogSource({
      live: () => readLiveCatalog(),
      bundled: () => readBundledCatalog(productFilesNear([...options.prefixArgs, options.command])),
    })
  }

  /**
   * 该模型是否原生支持图片输入。
   *
   * 以目录的原生模态表为准(精确 id + 平台否定票),`models.json` 只在目录
   * 缺项时兜底——平台 `supportsImages` 对纯文本模型也常为 true,不能直接采信。
   * @param model - 模型 id。
   * @returns 是否可按多模态引导。
   */
  /**
   * 模型本 step 真正能直接调用的工具面。
   *
   * 来源只能是 `GenerateOptions.tools` —— 它是 dsh 交给 provider 的那份声明,
   * PTC 会话里就是 `[run_code]`。**不能用注册表**(`tools.schemas()`):注册表
   * 里没有执行器传输工具,拿它当工具面会让桥/尾注描述一组模型其实直接调不到
   * 的工具(旧会话的 `unknown tool "read"` 连跪就是这个口径错误)。
   * @param options - 本 step 的模型请求。
   * @returns 该请求的工具声明;无工具时为空数组。
   */
  private surfaceOf(options: GenerateOptions): readonly DshSurfaceTool[] {
    return options.tools?.map(tool => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    })) ?? []
  }

  imageCapableOf(model: string): boolean {
    const entry = findCatalogModel(this.catalog.current(), model)
    if (entry !== undefined) return entry.modality === 'multimodal'
    return this.capabilities.capabilityOf(model).supportsImages
  }

  /**
   * 读图引导:判 CLI 侧通道,不判 dsh 工具注册表。
   *
   * 非 PTC 会话恒为 native —— `--tools` 白名单固定放行 `Read,ViewImage`
   * (见 acp.ts 的 `cliToolPolicyArgs`),ViewImage 走 CLI 自己的读图管线,
   * 不受"MCP 工具结果的图片按模型能力过滤"那条限制(`function_call_result`
   * → `[Image content filtered]`)。所以"能不能读图"由 CLI 策略决定:工具
   * 注册表在宿主平面,而工具按 agent 作用域挂载,子代理会话在这里查不到
   * `read_image`,曾把本来可用的读图误判成 unavailable(2026-11-27 实测:
   * 子代理成功调用 `mcp__dsh__read_image`,尾注却写着"本会话没有可用的读图
   * 工具")。
   *
   * PTC 会话例外:`--tools ''` 已禁掉 ViewImage,读图只能走程序里的
   * `tools.read_image`,于是按 dsh 工具在场情况分级(AGY 转述兜底)。
   * @param model - 本次请求路由到的 CodeBuddy 模型 id(仅回退路径使用)。
   * @param surface - 本 step 的模型工具面(只用于识别 PTC 单工具面;未知按非 PTC)。
   * @returns 读图引导档位。
   */
  private imageGuidanceFor(model: string, surface?: readonly DshSurfaceTool[]): ImageReadGuidance {
    const tools = this.toolsServiceOf()
    return imageGuidanceFrom({
      ptcOnly: isPtcOnlySurface(surface),
      readImage: tools?.get?.('read_image') !== undefined,
      agy: tools?.get?.('read_image_agy') !== undefined,
      toolsUnavailable: tools === undefined,
      modelImageCapable: this.imageCapableOf(model),
    })
  }

  /** dsh 的 tools 服务(缺席返回 undefined:极简/测试上下文)。 */
  private toolsServiceOf(): ToolsServiceFace | undefined {
    try {
      return (this.ctx as unknown as { get?: (key: string) => unknown }).get?.('tools') as ToolsServiceFace | undefined
    } catch {
      return undefined
    }
  }

  /** dsh tools 服务里是否存在该工具(缺席时不指路不存在的工具)。 */
  private hasTool(name: string): boolean {
    try {
      return this.toolsServiceOf()?.get?.(name) !== undefined
    } catch {
      return false
    }
  }

  /**
   * 绑定模型元数据与分发流入口(rc.2+ 的 LlmAdapter 接口)。
   * 显式实现而非依赖基类:插件对宿主 dsh-llm 版本保持兼容
   * (rc.6 宿主不调用此方法;rc.2+ 宿主调用本实现)。
   */
  override async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<{
    model: LlmResolvedModelInfo
    stream: (options: GenerateOptions) => AsyncIterable<StreamChunk>
  }> {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options) => this.stream(options),
    }
  }

  /** 取(或建)某会话的 todo 状态;首建时从已提交事件折叠最新 todo/write 播种。 */
  private todoStateFor(
    sessionId: string,
    session: { ownEvents?: () => readonly { type: string; data?: unknown }[] } | undefined,
  ): TodoListState {
    let state = this.todoStates.get(sessionId)
    if (state === undefined) {
      state = new TodoListState()
      state.seed(session?.ownEvents?.() ?? [])
      this.todoStates.set(sessionId, state)
    }
    return state
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    // 会话绑定 + 调用方已打开 step(= agent-loop 的对话轮)→ 回合泵(路线 C1)。
    // 泵把「一次 CodeBuddy 模型调用」映射成一个 dsh step:本方法每个 step 调
    // 一次,返回当前模型调用的内容;工具调用由泵注册的回放工具在 loop 侧承接,
    // 原生写出 `assistant/message` / `tool/call` / `tool/result`。
    const sessionId = options.sessionId
    if (options.purpose === undefined && sessionId !== undefined) {
      const session = this.ctx.get('sessions')?.get(sessionId) as TurnSessionFace | undefined
      const ownEvents = (session?.ownEvents?.() ?? []) as unknown as readonly SessionEvent[]
      const openStep = findOpenStep(ownEvents)
      if (session !== undefined && openStep !== undefined) {
        const started = await this.startTurn(options, sessionId, session, openStep)
        if (started.kind === 'skip') {
          // 本 step 输入全是「已插话投递」的消息:模型已在运行中读到并处理过它,
          // 重启 CLI 再补发 CONTINUE_PROMPT 会把模型从插话上拽回旧任务(实测
          // 踩坑:「插队没生效」的真凶)——空跑收尾。
          steerDebug('空跑收尾:本 step 输入均为已插话投递的消息')
          yield { type: 'finish', reason: { kind: 'stop' } }
          return
        }
        try {
          yield* started.pump.attach()
        } finally {
          // 回合被中止:泵(进程/计时器)一并收掉,避免残留。
          if (options.signal?.aborted === true) started.pump.dispose()
        }
        return
      }
    }
    // 辅助调用(压缩/会话标题,带 purpose)与无会话调用:一次性旁路会话。
    yield* this.streamOneShot(options)
  }

  /**
   * 建立/复用本回合的泵(路线 C1)。同一回合内的每个 step 都到这里:
   * 已有泵 → 直接续段(绝不重发 prompt);没有 → 编译本轮输入并启动泵。
   */
  private async startTurn(
    options: GenerateOptions,
    sessionId: string,
    childSession: TurnSessionFace,
    turnStep: { turn: number; step: number },
  ): Promise<{ kind: 'skip' } | { kind: 'pump'; pump: TurnPump }> {
    const toolSurface = this.surfaceOf(options)
    const existing = TurnPump.forSession(sessionId)
    if (existing !== undefined) {
      existing.updateToolSurface(toolSurface)
      return { kind: 'pump', pump: existing }
    }

    const model = options.model ?? this.options.modelOf()
    // 配额降级用的尝试顺序:显式点名的模型排第一,其余按设置的优先顺序补齐。
    const modelPlan = createModelPlan(model, this.options.modelFallbacksOf?.() ?? [])
    const defaultEffort = this.options.defaultEffortOf?.() ?? ''
    const reasoningEffort = options.reasoningEffort === undefined
      ? (defaultEffort === '' ? undefined : defaultEffort)
      : String(options.reasoningEffort)
    const bridgeMode = this.options.bridgeModeOf?.() ?? this.options.bridgeMode
    // 读图引导按 CLI 侧通道判定(非 PTC 恒 native:ViewImage 恒放行;PTC 内按
    // dsh read_image 在场分级,AGY 仅兜底)。
    const imageGuidance = this.imageGuidanceFor(model, toolSurface)
    const cwd = childSession.header.cwd ?? process.cwd()
    // dsh 的 system prompt 对齐原生语义:主代理轮也要带(工具桥已齐,旧注释
    // "它描述的是 CodeBuddy 调不到的工具"已失效)。带法见 systemHashOf:
    // 新会话随 seed 首条记录进入 CLI 历史;已存在的会话在内容变化时补发一次。
    const system = options.system
    const systemHash = systemHashOf(system, imageGuidance)

    const record = this.conversations.get(sessionId)
    let resume: { acpId: string } | undefined
    let prompt: string
    let images: Array<{ data: string; mimeType: string }> = []
    if (record !== undefined) {
      // 补发缺失轮次:锚点(上次发送时的消息数)之后的消息里,跳过 CodeBuddy
      // 自己产生的 assistant/tool 消息,其余(其他模型的轮次、新输入、压缩
      // 摘要)全部序列化补发;已被插话投递过的消息不重复补发。
      const replay = await resumeReplayPrompt(
        this.ctx,
        options.messages,
        record.sentCount,
        this.forwardedInsertions.get(sessionId),
        record.lastSentMessageId,
      )
      if (replay.skippedForwarded === true && record.sentCount !== undefined) return { kind: 'skip' }
      prompt = replay.prompt
      images = replay.images
      // system prompt 变了(或这个会话还从未发过):整份补发一次,模型由此拿到
      // 最新的 dsh 侧纪律(优先用 dsh_* 工具等)。
      if (system !== undefined && system.trim().length > 0 && record.systemHash !== systemHash) {
        const block = systemInstructionsText(
          system,
          record.systemHash !== undefined,
          bridgeMode ?? 'delegate',
          imageGuidance,
          isPtcOnlySurface(this.surfaceOf(options)),
        )
        prompt = `${block}\n\n${prompt}`
      }
      resume = { acpId: record.acpId }
    } else {
      // 新会话且带历史:把折叠后的历史转成 CodeBuddy 原生记录写成会话文件,
      // 以 session/load 载入——历史以原生消息进入,而不是压成一段提示词。
      const seed = await this.buildNativeSeed(options, cwd, imageGuidance, bridgeMode)
      if (seed !== undefined) {
        try {
          writeConversationFile(seed.file, seed.records, { sessionId: seed.sessionId, cwd })
          resume = { acpId: seed.sessionId }
          const last = await lastUserPrompt(this.ctx, options.messages)
          prompt = last.prompt
          images = last.images
        } catch {
          const built = await buildPrompt(this.ctx, options)
          prompt = built.prompt
          images = built.images
        }
      } else {
        const built = await buildPrompt(this.ctx, options)
        prompt = built.prompt
        images = built.images
      }
    }

    const attachments = this.attachmentsFace()
    const host: PumpHost = {
      ctx: this.ctx,
      command: this.options.command,
      prefixArgs: this.options.prefixArgs,
      extraArgs: this.options.extraArgs,
      bridgeMode,
      toolSurface,
      ...reasoningEffort === undefined ? {} : { reasoningEffort },
      // 配额降级:泵在零产出失败时先问 advanceModel(),成功才重启。
      modelOf: () => modelPlan.current(),
      ...(this.options.fallbackOnQuotaOf?.() ?? true ? { advanceModel: () => modelPlan.advance() } : {}),
      ...this.options.timeouts === undefined ? {} : { timeouts: this.options.timeouts },
      ...this.options.maxAttempts === undefined ? {} : { maxAttempts: this.options.maxAttempts },
      ...this.options.retryDelayMs === undefined ? {} : { retryDelayMs: this.options.retryDelayMs },
      ...this.options.steerPollMs === undefined ? {} : { steerPollMs: this.options.steerPollMs },
      ...this.options.nativeBaseDir === undefined ? {} : { nativeBaseDir: this.options.nativeBaseDir },
      dshSessionId: sessionId,
      model,
      cwd,
      acpCwd: cwd,
      ...resume === undefined ? {} : { resume },
      prompt,
      images,
      imageGuidance,
      fallbackPrompt: async () => {
        const built = await buildPrompt(this.ctx, options)
        return { prompt: built.prompt, images: built.images }
      },
      ...(systemHash === undefined ? {} : { systemHash }),
      rememberConversation: (acpId, sentCount, lastSentMessageId, hash) => {
        this.conversations.set(sessionId, {
          acpId,
          sentCount,
          ...(lastSentMessageId === undefined ? {} : { lastSentMessageId }),
          ...(hash === undefined ? {} : { systemHash: hash }),
        })
      },
      forgetConversation: () => { this.conversations.delete(sessionId) },
      sentCount: options.messages.length,
      // 补发主锚:本次发送覆盖到的最后一条消息(数量锚在压缩/编辑后不可靠——
      // 切到其他模型跑一段再切回时,数量锚越界会让补发退化成"只发最后一条")。
      ...(options.messages.length === 0
        ? {}
        : { sentLastMessageId: String(options.messages[options.messages.length - 1]!.id) }),
      session: {
        ownEvents: () => childSession.ownEvents?.() ?? [],
        ...childSession.append === undefined
          ? {}
          : { append: (type: string, data: unknown, opts?: { surfaceOp?: 'append' }) => childSession.append?.(type, data, opts) },
      },
      turnStep,
      childSession: {
        header: {
          ...childSession.header.agentPreset === undefined ? {} : { agentPreset: childSession.header.agentPreset },
          ...childSession.header.delegationDepth === undefined ? {} : { delegationDepth: childSession.header.delegationDepth },
          ...childSession.header.parentSession === undefined ? {} : { parentSession: childSession.header.parentSession },
        },
      },
      attachmentsOf: () => attachments,
      todoStateOf: () => this.todoStateFor(sessionId, childSession),
      markForwarded: id => this.markForwarded(sessionId, id),
      isForwarded: id => this.isForwarded(sessionId, id),
      unmarkForwarded: id => this.unmarkForwarded(sessionId, id),
    }
    return { kind: 'pump', pump: new TurnPump(host, options.signal, { mirroredCalls: new Set(), maxGapMs: 0 }) }
  }

  /**
   * 原生种子:新会话且带历史时,把折叠后的历史转成 CodeBuddy 原生记录
   * (由调用方写成会话文件 + session/load 载入)。转换失败返回 undefined,
   * 调用方退回纯提示词路径。
   */
  private async buildNativeSeed(
    options: GenerateOptions,
    cwd: string,
    imageGuidance: ImageReadGuidance,
    bridgeMode: 'mcp' | 'delegate' | undefined,
  ): Promise<{ sessionId: string; file: string; records: NativeRecord[] } | undefined> {
    if (options.messages.length <= 1) return undefined
    try {
      const sessionId = uuidv7()
      const attachments = this.ctx.get('attachments') as unknown as
        | { readImage: (ref: unknown) => Promise<{ data: Uint8Array; ref?: { mediaType?: string } }> }
        | undefined
      const records = await messagesToRecords(
        options.messages.slice(0, -1),
        { sessionId, cwd },
        attachments === undefined
          ? undefined
          : {
              readImage: ref => attachments.readImage(ref),
              ...this.options.nativeBaseDir === undefined ? {} : { blobsRoot: join(this.options.nativeBaseDir, '..', 'blobs') },
            },
        // dsh 的 system prompt 作为首条记录进 CLI 历史(对齐 dsh 原生行为)。
        options.system,
        bridgeMode ?? 'delegate',
        imageGuidance,
        isPtcOnlySurface(this.surfaceOf(options)),
      )
      if (records.length === 0) return undefined
      return { sessionId, file: conversationFilePath(sessionId, cwd, this.options.nativeBaseDir), records }
    } catch {
      return undefined
    }
  }

  /**
   * 一次性旁路会话(带 purpose 的辅助调用 / 无会话调用)。可重试失败
   * (静默空跑/半途终止/进程退出/超时)时恢复同一会话续跑;用尽后以显式
   * 错误收尾。不写任何会话事件——调用方不是 agent-loop 的对话轮。
   */
  private async *streamOneShot(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const maxAttempts = this.options.maxAttempts ?? 2
    const retryDelayMs = this.options.retryDelayMs ?? 3_000
    // attempt 之间共享已学到的进展间隔,避免每次 attempt 都从下限预算重新开始。
    const state = { maxGapMs: 0 }
    for (let attempt = 1; ; attempt++) {
      const isLast = attempt >= maxAttempts
      try {
        yield* this.oneShotOnce(options, state)
        return
      } catch (error) {
        if (options.signal?.aborted) return
        if (!(error instanceof RetryableError) || isLast) {
          yield {
            type: 'finish',
            reason: {
              kind: 'error',
              failure: {
                message: (error instanceof Error ? error.message : String(error)).slice(0, 500),
                code: 'CODEBUDDY_EXEC_ERROR',
              },
            },
          }
          return
        }
        await new Promise<void>(resolve => setTimeout(resolve, retryDelayMs))
        if (options.signal?.aborted) return
      }
    }
  }

  /** 单次旁路委托:进程 + 握手 + prompt + update 消费(纯 chunk,零会话写入)。 */
  private async *oneShotOnce(
    options: GenerateOptions,
    state: { maxGapMs: number },
  ): AsyncIterable<StreamChunk> {
    const { command, prefixArgs } = this.options
    const bridgeMode = this.options.bridgeModeOf?.() ?? this.options.bridgeMode
    // 请求级 model 优先(子代理可经 agentOptions.model 动态指定),回退到当前默认模型。
    const model = options.model ?? this.options.modelOf()
    // 读图引导(旁路会话同样要带,哈希与种子都要用)。这里**不传 surface**:
    // 旁路 spawn 走的 `cliToolPolicyArgs(bridgeMode)` 没有 ptcOnly,ViewImage
    // 恒放行,故引导恒为 native,与该进程实际的 `--tools` 一致。
    const imageGuidance = this.imageGuidanceFor(model)
    // 辅助调用(会话标题/压缩)是**旁路查询**:必须用一次性会话,绝不读写
    // 本会话的续接映射、也绝不原生种子——否则会抢写映射(实测:标题调用把
    // 映射覆盖成标题会话,镜像/续聊全部找错会话)并把旁路请求塞进真实对话。
    const purposeCall = options.purpose !== undefined
    const dshSessionId = options.sessionId
    const record = dshSessionId === undefined || purposeCall ? undefined : this.conversations.get(dshSessionId)
    const isResume = record !== undefined

    const childSession = dshSessionId !== undefined && !purposeCall
      ? this.ctx.get('sessions')?.get(dshSessionId) as TurnSessionFace | undefined
      : undefined
    const cwd = childSession?.header.cwd ?? process.cwd()
    // 辅助调用(标题/压缩)在独立临时目录跑:一次性旁路会话不落进用户项目,
    // 避免 CodeBuddy 历史列表被标题小会话刷屏。
    const acpCwd = purposeCall ? purposeWorkDir() : cwd
    let prompt: string
    let promptImages: Array<{ data: string; mimeType: string }> = []
    // 新会话且带历史:历史走原生会话文件(session/load)。
    let nativeSeed: { sessionId: string; file: string; records: NativeRecord[] } | undefined
    if (!isResume && !purposeCall) nativeSeed = await this.buildNativeSeed(options, cwd, imageGuidance, bridgeMode)
    if (record !== undefined) {
      const replay = await resumeReplayPrompt(
        this.ctx,
        options.messages,
        record.sentCount,
        dshSessionId === undefined ? undefined : this.forwardedInsertions.get(dshSessionId),
        record.lastSentMessageId,
      )
      prompt = replay.prompt
      promptImages = replay.images
      // 本 step 输入均为已插话投递的消息:空跑收尾(见 stream 路由注释)。
      if (replay.skippedForwarded === true && record.sentCount !== undefined) {
        steerDebug('空跑收尾(旁路):本 step 输入均为已插话投递的消息')
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
    } else if (nativeSeed !== undefined) {
      const last = await lastUserPrompt(this.ctx, options.messages)
      prompt = last.prompt
      promptImages = last.images
    } else {
      const built = await buildPrompt(this.ctx, options)
      prompt = built.prompt
      promptImages = built.images
    }

    try {
      // ── update 泵:回调把 update 推进队列,generator 在此处消费 ─────────
      // capturing 期间(initialize/new/load 完成之前)的 update 全部丢弃——
      // session/load 会同步回放历史事件,不能落地成新内容。
      let capturing = true
      const queue: AcpUpdate[] = []
      let wake: (() => void) | undefined
      const onUpdate = (update: AcpUpdate): void => {
        if (capturing) return
        queue.push(update)
        const w = wake
        wake = undefined
        w?.()
      }
      const waitForUpdate = async (): Promise<void> => {
        if (queue.length > 0) return
        await new Promise<void>(resolve => { wake = resolve })
      }

      // ── 动态空闲超时:进展性 update 续命;两段收尾(cancel → kill) ──────
      const to = { ...DEFAULT_ACP_RUN_TIMEOUTS, ...this.options.timeouts }
      const startedAt = Date.now()
      let stallTimedOut = false
      let killTimer: ReturnType<typeof setTimeout> | undefined
      let maxGapMs = state.maxGapMs
      let lastProgressAt = startedAt
      let progressSamples = 0
      let lastBudgetMs = to.idleMaxMs
      let acpSessionId = ''
      let textLanded = 0
      let toolsLanded = 0
      /** 本次调用的最新一条用量样本(末位采样,不累加——累加会顶满上下文窗口)。 */
      let lastUsage: TokenUsage | undefined
      /** 在途工具(只有 start/complete 两个事件,长工具期间无心跳)。 */
      const pendingTools = new Set<string>()

      /** 延写块:下一块到位时丢弃;流末的块走收尾 chunk(job 调用只要最终文本)。 */
      let pendingPiece: { closed: StreamChunk[]; block: ContentBlock } | undefined
      let currentStream: {
        messageId: string
        blockType: 'text' | 'reasoning'
        index: number
        text: string
        chunks: StreamChunk[]
      } | undefined
      let nextBlockIndex = 0

      /** 块收尾:闭合当前文本/思考块;上一块被替换(旁路调用只交付最后一块)。 */
      const flushPending = (): void => {
        if (currentStream === undefined) return
        const { index, text, chunks, blockType } = currentStream
        const block: ContentBlock = blockType === 'text' ? { type: 'text', text } : { type: 'reasoning', text }
        const closed: StreamChunk[] = [...chunks, { type: 'block-end', index, block }]
        currentStream = undefined
        if (text.length === 0) return
        if (blockType === 'text') textLanded += 1
        pendingPiece = { closed, block }
      }
      const releasePending = (): void => {
        if (pendingPiece === undefined) return
        pendingChunks.push(...pendingPiece.closed)
        pendingPiece = undefined
      }
      const pendingChunks: StreamChunk[] = []

      const kill = (): void => { try { conn.kill() } catch { /* 已退出 */ } }
      const failStall = (): void => {
        stallTimedOut = true
        // 第一段:协议级取消(CLI 事件循环若还活着就能收尾)。
        if (acpSessionId !== '') conn.notify('session/cancel', { sessionId: acpSessionId })
        // 第二段:5s 仍无响应才杀进程——纯死挂只有这一条路。
        if (killTimer === undefined) killTimer = setTimeout(kill, 5_000)
      }

      /**
       * 独立看门狗:与消费方是否还在迭代生成器无关(消费方被回收时生成器的
       * finally 可能永不执行——实测进程泄漏、子会话回合悬空)。静默判死已
       * 整体移除:CLI 等上游/长思考时可长时间零事件,只保留"在途工具永不
       * 返回"的硬顶;其余终止交给进程退出(挂起请求 reject)或调用方取消。
       */
      const guardTimer = setInterval(() => {
        if (stallTimedOut) {
          clearInterval(guardTimer)
          return
        }
        if (pendingTools.size > 0) {
          // 在途工具的硬顶兜底(cap<=0 = 关闭硬顶)。
          const cap = to.guardCapMs ?? 30 * 60_000
          const idleFor = Date.now() - lastProgressAt
          if (cap > 0 && idleFor > cap) failStall()
        }
      }, 3_000)
      guardTimer.unref?.()
      const armIdle = (): void => {
        const now = Date.now()
        maxGapMs = Math.max(maxGapMs, now - lastProgressAt)
        state.maxGapMs = maxGapMs
        lastProgressAt = now
        progressSamples += 1
        lastBudgetMs = progressSamples <= to.idleWarmupLines
          ? to.idleMaxMs
          : Math.min(Math.max(maxGapMs * to.idleFactor, to.idleMinMs), to.idleMaxMs)
      }

      /** 处理一条 ACP update:续命 + 流累积(不写会话事件)。 */
      const handleUpdate = (update: AcpUpdate): void => {
        if (isProgressUpdate(update)) armIdle()
        switch (update.sessionUpdate) {
          case 'agent_thought_chunk':
          case 'agent_message_chunk': {
            const text = update.content?.text ?? ''
            if (text.length === 0) return
            const blockType = update.sessionUpdate === 'agent_thought_chunk' ? 'reasoning' : 'text'
            const messageId = update.messageId ?? `${blockType}-anonymous`
            if (currentStream === undefined || currentStream.messageId !== messageId || currentStream.blockType !== blockType) {
              flushPending()
              currentStream = {
                messageId,
                blockType,
                index: nextBlockIndex++,
                text: '',
                chunks: [{ type: 'block-start', index: nextBlockIndex - 1, blockType }],
              }
            }
            currentStream.text += text
            currentStream.chunks.push({ type: 'text-delta', index: currentStream.index, text })
            return
          }
          case 'usage_update': {
            const sample = usageOfUpdate(update)
            if (sample === undefined) return
            lastUsage = sample
            return
          }
          case 'tool_call': {
            if (update.toolCallId === undefined) return
            if (pendingTools.has(update.toolCallId)) return
            const complete = update._meta?.['codebuddy.ai/toolArgumentsComplete'] === true
              || update.status === 'pending'
            if (!complete) {
              pendingTools.add(update.toolCallId)
              return
            }
            pendingTools.delete(update.toolCallId)
            toolsLanded += 1
            return
          }
          case 'tool_call_update': {
            if (update.toolCallId === undefined) return
            if (update.status !== 'completed' && update.status !== 'failed') return
            pendingTools.delete(update.toolCallId)
            toolsLanded += 1
            return
          }
          default:
            return
        }
      }

      // ── 建 ACP 进程 + 握手 + 会话 ────────────────────────────────────────
      // 推理强度:调用方选中的 effort 以 `--effort <level>` 传参(未选则保持 CLI 默认)。
      const effortArgs = options.reasoningEffort === undefined
        ? []
        : ['--effort', String(options.reasoningEffort)]
      syncSkillsToCodebuddy({ projectCwd: cwd })
      if (!purposeCall && bridgeMode === 'mcp') registerDshMcpServer(this.ctx)
      const conn = new AcpConnection(
        [
          command,
          ...prefixArgs,
          '--acp',
          '--model',
          model,
          ...effortArgs,
          '--dangerously-skip-permissions',
          ...cliToolPolicyArgs(bridgeMode),
          ...mcpConfigArgs(bridgeMode, purposeCall ? undefined : dshSessionId),
          ...this.options.extraArgs,
        ],
        cwd,
        onUpdate,
      )
      let exitError: Error | undefined
      conn.onExit(info => {
        if (conn.wasKilled || stallTimedOut) return
        exitError = info.error ?? new Error(
          `CodeBuddy ACP 进程退出(code ${info.code ?? 'null'}${info.signal !== null ? `,signal ${info.signal}` : ''})${conn.stderrNote()}`,
        )
        const w = wake
        wake = undefined
        w?.()
      })

      // abort → 周期性 session/cancel(思考早期单次通知可能被吞,实测)。
      let cancelLoopTimer: ReturnType<typeof setInterval> | undefined
      const onAbort = (): void => {
        cancelLoopTimer = setInterval(() => {
          if (acpSessionId !== '') conn.notify('session/cancel', { sessionId: acpSessionId })
        }, 1_000)
      }
      options.signal?.addEventListener('abort', onAbort, { once: true })

      let openingSession = true
      try {
        await conn.request('initialize', {
          protocolVersion: 1,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
        }, to.firstMs)

        if (isResume && record !== undefined && dshSessionId !== undefined) {
          // 历史回放:load 响应前的 update 已被 capturing 丢弃。
          try {
            await conn.request('session/load', { sessionId: record.acpId, cwd: acpCwd, mcpServers: [] })
            acpSessionId = record.acpId
          } catch (error) {
            if (!isMissingAcpSession(error)) throw error
            // CodeBuddy 侧会话存储丢失:回退新会话 + 完整历史重发。
            this.conversations.delete(dshSessionId)
            const full = await buildPrompt(this.ctx, options)
            prompt = full.prompt
            promptImages = full.images
            const created = await conn.request<{ sessionId: string }>('session/new', { cwd: acpCwd, mcpServers: [] }, to.firstMs)
            acpSessionId = created.sessionId
          }
        } else if (nativeSeed !== undefined) {
          // 原生种子:写会话文件 + session/load(历史以原生消息进入)。
          let seedWritten = false
          try {
            writeConversationFile(nativeSeed.file, nativeSeed.records, { sessionId: nativeSeed.sessionId, cwd })
            seedWritten = true
            await conn.request('session/load', { sessionId: nativeSeed.sessionId, cwd: acpCwd, mcpServers: [] })
            acpSessionId = nativeSeed.sessionId
          } catch (error) {
            if (seedWritten && !isMissingAcpSession(error)) throw error
            // 合成文件无法写入或找不到:退回新会话 + 全量提示词。
            const full = await buildPrompt(this.ctx, options)
            prompt = full.prompt
            promptImages = full.images
            const created = await conn.request<{ sessionId: string }>('session/new', { cwd: acpCwd, mcpServers: [] }, to.firstMs)
            acpSessionId = created.sessionId
          }
        } else {
          const created = await conn.request<{ sessionId: string }>('session/new', { cwd: acpCwd, mcpServers: [] }, to.firstMs)
          acpSessionId = created.sessionId
        }
        // 记录/刷新续接锚点:sentCount = 本次实际发送时的 dsh 消息总数。
        // 主锚与 system 哈希必须一并落:set 是整体替换,缺字段会把泵路径写的
        // 记录覆盖回数量锚(压缩/编辑后不可靠,切换期间的上下文被静默丢弃)。
        if (dshSessionId !== undefined && !purposeCall) {
          const hash = systemHashOf(options.system, imageGuidance)
          this.conversations.set(dshSessionId, {
            acpId: acpSessionId,
            sentCount: options.messages.length,
            ...(options.messages.length === 0
              ? {}
              : { lastSentMessageId: String(options.messages[options.messages.length - 1]!.id) }),
            ...(hash === undefined ? {} : { systemHash: hash }),
          })
        }
        openingSession = false
        capturing = false

        // ── prompt:消费 update 直到在飞 prompt 结束 ───────────────────────
        // session/prompt 是长活请求:不设请求超时(传 0),生命周期由动态空闲
        // 超时(cancel → kill → 进程退出 reject)与 abort 保护。
        let promptResult: AcpPromptResult | undefined
        let promptError: Error | undefined
        let inFlight = 0
        const sendPrompt = (blocks: Array<Record<string, unknown>>): void => {
          inFlight += 1
          void conn.request<AcpPromptResult>(
            'session/prompt',
            { sessionId: acpSessionId, prompt: blocks },
            0,
          ).then(
            v => { promptResult = v },
            e => { promptError = e instanceof Error ? e : new Error(String(e)) },
          ).finally(() => { inFlight -= 1 })
        }
        sendPrompt([
          { type: 'text', text: prompt },
          ...promptImages.map(image => ({ type: 'image', data: image.data, mimeType: image.mimeType })),
        ])

        pump: while (true) {
          while (inFlight > 0 && promptError === undefined && exitError === undefined && !stallTimedOut) {
            while (queue.length > 0) {
              const update = queue.shift()
              if (update !== undefined) handleUpdate(update)
            }
            while (pendingChunks.length > 0) yield pendingChunks.shift()!
            if (inFlight <= 0 || promptError !== undefined || exitError !== undefined || stallTimedOut) break
            await Promise.race([waitForUpdate(), new Promise<void>(resolve => setTimeout(resolve, 100))])
          }
          while (queue.length > 0) {
            const update = queue.shift()
            if (update !== undefined) handleUpdate(update)
          }
          while (pendingChunks.length > 0) yield pendingChunks.shift()!
          break pump
        }
        // 抽干尾部(cancel/exit 后可能还有少量 update)。
        while (queue.length > 0) {
          const update = queue.shift()
          if (update !== undefined) handleUpdate(update)
        }
        while (pendingChunks.length > 0) yield pendingChunks.shift()!

        // 失败分类:可重试的走 RetryableError(外层恢复会话续跑)。
        if (stallTimedOut) {
          flushPending()
          throw new RetryableError(`CodeBuddy ACP 调用超时(已等待 ${Math.round((Date.now() - startedAt) / 1000)}s;`
            + `在途工具 ${pendingTools.size} 个超过硬顶未返回,本次历史最大进展间隔 ${Math.round(maxGapMs / 1000)}s,`
            + `已收 ${progressSamples} 次进展${conn.stderrNote()})`)
        }
        if (promptError !== undefined) {
          throwFailure('CodeBuddy ACP 请求失败:', failureOfError(promptError), conn.stderrNote())
        }
        if (exitError !== undefined) throw exitError
        if (options.signal?.aborted === true) {
          flushPending()
          releasePending()
          if (lastUsage !== undefined) pendingChunks.push({ type: 'usage', usage: lastUsage })
          while (pendingChunks.length > 0) yield pendingChunks.shift()!
          return
        }

        const stopReason = promptResult?.stopReason
        // 失败详情优先取顶层 errorMessage;refusal 场景只有
        // `_meta["codebuddy.ai/errorMessage"]`(JSON:code/category/statusCode/
        // displayMsg 多语言文案)与 `codebuddy.ai/outcome`(FAILED_MODEL_REQUEST 等)。
        const metaError = promptResult?._meta?.['codebuddy.ai/errorMessage']
        const metaOutcome = promptResult?._meta?.['codebuddy.ai/outcome']
        const errorMessage = firstNonEmpty(
          promptResult?.errorMessage,
          typeof metaError === 'string' ? metaError : undefined,
        )
        const failureOutcome = isFailureOutcome(metaOutcome) ? metaOutcome : undefined
        flushPending()
        releasePending()
        if (lastUsage !== undefined) pendingChunks.push({ type: 'usage', usage: lastUsage })
        while (pendingChunks.length > 0) yield pendingChunks.shift()!
        if (errorMessage !== undefined || failureOutcome !== undefined) {
          throwFailure(
            'CodeBuddy 中断:',
            parseCodebuddyFailure(errorMessage, undefined, failureOutcome),
            conn.stderrNote(),
          )
        }
        // 静默失败防御(实测高频):end_turn 但零思考、零文本、零工具。
        // 工具落地也算产出:纯工具轮次(无解说文本)是正常形态。
        if (stopReason !== 'cancelled' && (progressSamples === 0 || (textLanded === 0 && toolsLanded === 0))) {
          throw new RetryableError(`CodeBuddy 静默失败(stopReason: ${stopReason ?? 'none'};`
            + `${progressSamples} 次进展、0 次文本/工具产出)——可能是配额受限或服务端异常`)
        }
        // end_turn + 有产出,或 cancelled:正常收尾。
        yield {
          type: 'finish',
          reason: stopReason === 'max_tokens' || stopReason === 'max-tokens'
            ? { kind: 'max-tokens' }
            : { kind: 'stop' },
        }
      } catch (error) {
        if (!openingSession) throw error
        // 进程异常退出保持显式终止；spawn 错误由分类器给出配置提示。
        if (exitError !== undefined && exitError !== error) throw exitError
        throwFailure('CodeBuddy ACP 握手失败:', failureOfError(error), conn.stderrNote())
      } finally {
        clearInterval(guardTimer)
        if (killTimer !== undefined) clearTimeout(killTimer)
        if (cancelLoopTimer !== undefined) clearInterval(cancelLoopTimer)
        options.signal?.removeEventListener('abort', onAbort)
        conn.kill()
      }
    } finally {
    }
  }

  override resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    // 逐模型元数据以 CLI 目录为准(窗口/档位/原生模态)。目录缺项时保守回退:
    // 只声明 text(不谎报多模态)、窗口 1M、档位整套 CLI 档位。入口门是否放行
    // 带图消息由 inputModalities 决定——目录判定 only-text 的模型不再谎报图片。
    const entry = findCatalogModel(this.catalog.current(), model)
    // 目录缺项(自定义模型/离线/CLI 目录未缓存)时回落到 models.json 的用户声明:
    // 目录是"我们查到的",models.json 是"用户声明的",两者都不猜。
    const imageCapable = entry === undefined ? this.imageCapableOf(model) : entry.modality === 'multimodal'
    const efforts = entry?.efforts
    const shared = {
      provider,
      id: model,
      name: entry === undefined ? model : catalogModelName(entry),
      description: entry === undefined ? undefined : `CodeBuddy (ACP) model ${model}`,
      inputModalities: (imageCapable ? ['text', 'image'] : ['text']) as readonly ModelModality[],
      context: { contextWindow: entry?.contextWindow ?? 1_000_000 },
    }
    if (efforts === undefined || efforts.length === 0) {
      // 目录明确"无推理档位"的模型不暴露 efforts(传了会被 dsh 拒);目录缺项时
      // 保留整套 CLI 档位,避免把未知当无。
      if (entry === undefined) {
        return Promise.resolve({
          ...shared,
          reasoning: {
            efforts: CODEBUDDY_EFFORTS.map(effort => ({
              id: ReasoningEffortId(effort.level),
              name: effort.name,
              description: effort.description,
            })),
          },
        })
      }
      return Promise.resolve({ ...shared })
    }
    return Promise.resolve({
      ...shared,
      reasoning: {
        efforts: efforts.map(id => ({ id: ReasoningEffortId(id), name: effortLabel(id) })),
        ...(entry?.defaultEffort === undefined ? {} : { defaultEffort: ReasoningEffortId(entry.defaultEffort) }),
      },
    })
  }

  /** 主模型选择器里的 provider 分组名。 */
  override providerInfo(provider: string): { id: string; name: string } {
    return { id: provider, name: 'CodeBuddy' }
  }

  /**
   * 主模型选择器的模型目录:目录里的可选用名册(实时目录 `agents[].models`,
   * 离线时 bundled 兜底)∪ 设置里的默认模型。
   *
   * 名称带积分倍率(`DeepSeek-V4.1-Flash · x0.11`)——与 dsh-connect-workbuddy
   * 同口径:宿主原样渲染 `name`,倍率不进 description、不另设字段。description
   * 保留 `CodeBuddy (ACP) model <id> · 支持图片输入|仅文本`,因为子代理模型
   * 目录(list_subagent_models)把 description 当唯一通道。
   *
   * 目录路径会被客户端每次拉取时调用,CLI 可能缺失/挂起——因此异步 spawn
   * 只用于扩展 id、成功缓存 10 分钟、失败缓存 60 秒、并发合并,**永不抛错**。
   */
  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const now = Date.now()
    if (this.modelCache !== undefined && now - this.modelCache.at < SUCCESS_TTL_MS) return this.modelCache.models
    if (this.modelFetch !== undefined) return this.modelFetch
    const configured = this.options.modelOf()
    this.modelFetch = (async (): Promise<readonly LlmModelInfo[]> => {
      const snapshot = this.catalog.current()
      let ids = snapshot.selectable.length > 0
        ? [...snapshot.selectable]
        : snapshot.models.map(model => model.id)
      if (ids.length === 0) {
        // 目录完全不可用(无实时缓存、无 bundled 文件)时退回 CLI 名册。
        ids = await listCodebuddyModelIdsAsync(this.options.command, this.options.prefixArgs).catch(() => [])
      }
      const all = [...new Set([...ids, ...(configured.length > 0 ? [configured] : [])])]
      const models = all.map((id): LlmModelInfo => {
        const entry = findCatalogModel(snapshot, id)
        if (entry === undefined) {
          const imageCapable = this.imageCapableOf(id)
          return {
            provider,
            id,
            name: id,
            description: `CodeBuddy (ACP) model ${id}${imageCapable ? ' · 支持图片输入' : ' · 仅文本'}`,
            inputModalities: imageCapable ? ['text', 'image'] : ['text'],
          }
        }
        return {
          provider,
          id,
          name: catalogModelName(entry),
          description: `CodeBuddy (ACP) model ${id}${entry.modality === 'multimodal' ? ' · 支持图片输入' : ' · 仅文本'}`,
          inputModalities: catalogInputModalities(entry),
          ...(entry.free
            ? { badge: { text: { en: 'free', zh: '免费' }, tone: 'success' as const } }
            : {}),
        }
      })
      this.modelCache = { models, at: Date.now() }
      return models
    })().catch((): readonly LlmModelInfo[] => {
      const fallback = this.modelCache?.models
        ?? (configured.length > 0 ? [{ provider, id: configured, name: configured }] : [])
      this.modelCache = { models: fallback, at: Date.now() - SUCCESS_TTL_MS + FAILURE_TTL_MS }
      return fallback
    }).finally(() => { this.modelFetch = undefined })
    return this.modelFetch
  }
}
