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
import type { Context } from '@deepseek-ai/cordis';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import { ConversationStore } from './conversations.js';
import type { AcpTimeouts } from './acp.js';
import type { ImageReadGuidance } from './pump.js';
import type { ModelCapabilityIndex } from './model-capabilities.js';
import type { CatalogSource } from './catalog.js';
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
export declare function imageGuidanceFrom(facts: {
    /** 本 step 的工具面是否就是 PTC 的 `run_code` 单工具面。 */
    readonly ptcOnly: boolean;
    /** dsh 侧 `read_image` 是否已注册(子代理作用域下宿主平面看不到)。 */
    readonly readImage: boolean;
    /** dsh 侧 `read_image_agy` 是否已注册(AGY 转述)。 */
    readonly agy: boolean;
    /** tools 服务是否缺席(极简/测试上下文)。 */
    readonly toolsUnavailable: boolean;
    /** 模型是否原生支持图片输入(仅在 tools 服务缺席时兜底)。 */
    readonly modelImageCapable: boolean;
}): ImageReadGuidance;
/**
 * 会话中最后一个已打开(尚无配对 step/end)的 turn/step。
 *
 * 它是「调用方是 agent-loop 的对话轮」的判据:只有这种调用才走回合泵
 * (路线 C1,一个 CodeBuddy 回合 = 多个原生 step);压缩/标题这类旁路调用
 * 没有打开 step,走一次性会话。
 * @param events - 会话自身的已提交事件(ownEvents)。
 * @returns 打开的 turn/step,没有则为 undefined。
 */
export declare function findOpenStep(events: readonly SessionEvent[]): {
    turn: number;
    step: number;
} | undefined;
/** CodeBuddy CLI 入口配置(由 index.ts 解析)。 */
export interface CodebuddyAdapterOptions {
    /** 可执行入口(node 脚本绝对路径或命令)。 */
    command: string;
    /** 前置参数(如解析出的 CLI 路径)。 */
    prefixArgs: string[];
    /** 读取当前默认模型(调用时求值,设置面板改默认模型后对新请求实时生效)。 */
    modelOf: () => string;
    /**
     * 模型优先顺序(设置里的完整列表,第一项是默认模型)。配额/限流失败且
     * 本回合尚无产出时,回合泵按此顺序换下一个模型重开 CLI 会话。
     */
    modelFallbacksOf?: () => readonly string[];
    /** 配额/限流失败时是否允许自动换模型(默认 true)。 */
    fallbackOnQuotaOf?: () => boolean;
    /** 子代理默认思考强度('' = 不传 `--effort`)。 */
    defaultEffortOf?: () => string;
    /** 传给 `--permission-mode` 的权限模式。 */
    permissionMode: string;
    /** 追加的额外 CodeBuddy 参数。 */
    extraArgs: string[];
    /**
     * 工具桥接模式(默认 `mcp`):mcp = spawn 加 `--mcp-config` 连 dsh 的
     * HTTP MCP server;delegate = 旧 DelegateTool 通道(不加该参数)。
     */
    bridgeMode?: 'mcp' | 'delegate';
    bridgeModeOf?: () => 'mcp' | 'delegate';
    /** 动态空闲超时预算(可选,默认见 {@link DEFAULT_ACP_RUN_TIMEOUTS})。 */
    timeouts?: AcpTimeouts;
    /** 静默失败自动重试次数(默认 2:首次 + 1 次续跑)。 */
    maxAttempts?: number;
    /** 重试间隔(毫秒,默认 3s)。 */
    retryDelayMs?: number;
    /** 中途插入轮询间隔(毫秒,默认 1200;测试用小值)。 */
    steerPollMs?: number;
    /** 续接映射存储(默认持久化到 `~/.dsh/codebuddy/conversations.json`;测试传纯内存)。 */
    store?: ConversationStore;
    /** 原生会话文件根目录(默认 `~/.codebuddy/projects`;测试注入临时目录)。 */
    nativeBaseDir?: string;
    /**
     * 模型能力索引(默认读 `<configDir>/models.json` 的 `supportsImages`;
     * 测试注入假索引,避免读真实 `~/.codebuddy`)。
     */
    capabilities?: ModelCapabilityIndex;
    /**
     * 模型目录来源(名册/倍率/窗口/档位/原生模态)。默认读 CLI 实时目录,
     * bundled `product*.json` 只作离线兜底;测试注入固定快照。
     */
    catalog?: CatalogSource;
}
/**
 * CodeBuddy 模型适配器。stream() 每次调用:
 * spawn `codebuddy --acp` → initialize → session/new(或 session/load 复用)
 * → session/prompt → 消费 session/update(思考/文本/工具)→ finish 收尾。
 * 每次调用一个 ACP 进程,用完退出;会话连续性由 CodeBuddy 会话存储 +
 * session/load 保证(实测回放完整);续接映射持久化,服务重启后自动恢复;
 * 静默失败自动恢复会话续跑。
 */
export declare class CodebuddyLlmAdapter extends LlmAdapter {
    private readonly ctx;
    private readonly options;
    /**
     * dsh 会话 → CodeBuddy ACP 会话的续接映射(持久化,跨服务重启恢复)。
     *
     * 首次调用 `session/new` 建立并记录;之后同一会话的每次 stream 都
     * `session/load` 载入同一会话(官方实现会先回放历史事件,回放不落地)。
     */
    private readonly conversations;
    /** listModels 缓存与并发合并(目录拉取热路径)。 */
    private modelCache;
    private modelFetch;
    /** 中继回退:同一会话最多保留的转发 id 数(防无界增长)。 */
    private static readonly FORWARDED_CAP;
    /** dsh 会话 → todo 列表状态(CodeBuddy 任务工具折算整表快照,跨轮复用)。 */
    private readonly todoStates;
    /** dsh 会话 → 已转发的插入消息 id(续聊补发时跳过,防重复)。 */
    private readonly forwardedInsertions;
    /** dsh attachments 服务面(单图入库;原生 read_image 同法)。 */
    private attachmentsFace;
    /** 标记一条插入为已转发;已标记过返回 false。 */
    private markForwarded;
    /** 查询一条插入是否已投递过。 */
    private isForwarded;
    /** 撤销一条转发标记(投递确认失败时回滚,留给补发路径)。 */
    private unmarkForwarded;
    /** 模型图片能力索引(`models.json` 的 `supportsImages`;未知按仅文本)。 */
    private readonly capabilities;
    /** 模型目录来源(实时名册/倍率/窗口/档位/模态)。 */
    private readonly catalog;
    constructor(ctx: Context, options: CodebuddyAdapterOptions);
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
    private surfaceOf;
    imageCapableOf(model: string): boolean;
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
    private imageGuidanceFor;
    /** dsh 的 tools 服务(缺席返回 undefined:极简/测试上下文)。 */
    private toolsServiceOf;
    /** dsh tools 服务里是否存在该工具(缺席时不指路不存在的工具)。 */
    private hasTool;
    /**
     * 绑定模型元数据与分发流入口(rc.2+ 的 LlmAdapter 接口)。
     * 显式实现而非依赖基类:插件对宿主 dsh-llm 版本保持兼容
     * (rc.6 宿主不调用此方法;rc.2+ 宿主调用本实现)。
     */
    prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<{
        model: LlmResolvedModelInfo;
        stream: (options: GenerateOptions) => AsyncIterable<StreamChunk>;
    }>;
    /** 取(或建)某会话的 todo 状态;首建时从已提交事件折叠最新 todo/write 播种。 */
    private todoStateFor;
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
    /**
     * 建立/复用本回合的泵(路线 C1)。同一回合内的每个 step 都到这里:
     * 已有泵 → 直接续段(绝不重发 prompt);没有 → 编译本轮输入并启动泵。
     */
    private startTurn;
    /**
     * 原生种子:新会话且带历史时,把折叠后的历史转成 CodeBuddy 原生记录
     * (由调用方写成会话文件 + session/load 载入)。转换失败返回 undefined,
     * 调用方退回纯提示词路径。
     */
    private buildNativeSeed;
    /**
     * 一次性旁路会话(带 purpose 的辅助调用 / 无会话调用)。可重试失败
     * (静默空跑/半途终止/进程退出/超时)时恢复同一会话续跑;用尽后以显式
     * 错误收尾。不写任何会话事件——调用方不是 agent-loop 的对话轮。
     */
    private streamOneShot;
    /** 单次旁路委托:进程 + 握手 + prompt + update 消费(纯 chunk,零会话写入)。 */
    private oneShotOnce;
    resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
    /** 主模型选择器里的 provider 分组名。 */
    providerInfo(provider: string): {
        id: string;
        name: string;
    };
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
    listModels(provider: string): Promise<readonly LlmModelInfo[]>;
}
