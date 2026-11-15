/** 原生模态:只有两态可确认,表外视为 unknown(按仅文本处理)。 */
export type CodebuddyModality = 'text' | 'multimodal';
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
export declare const MULTIMODAL_MODEL_IDS: ReadonlySet<string>;
/**
 * workbuddy 明确记为纯文本、但 CodeBuddy 目录声明 `supportsImages: true` 的
 * id。列出来是为了让"平台声明不可信"这件事在代码里可查:两边描述同一模型时
 * 以 workbuddy 的核实结论为准。
 */
export declare const TEXT_ONLY_MODEL_IDS: ReadonlySet<string>;
/** 目录条目(适配器与设置卡共用的一份形状)。 */
export interface CodebuddyCatalogModel {
    readonly id: string;
    /** 上游展示名(`DeepSeek-V4.1-Flash`);缺失时回退 id。 */
    readonly name: string;
    /** 积分倍率(0.11 表示 x0.11);缺失表示上游未报价。 */
    readonly credits?: number;
    /** 条目是否免费档(credits = 0 且上游标注 free,或倍率为 0)。 */
    readonly free: boolean;
    /** 上下文窗口(上游 `maxInputTokens`)。 */
    readonly contextWindow?: number;
    readonly maxOutputTokens?: number;
    /** 原生模态(精确 id 表 + 平台否定票,见模块头)。 */
    readonly modality: CodebuddyModality;
    /** 可选择的推理档位(已按 CLI `--effort` 白名单收敛);空数组表示不暴露档位。 */
    readonly efforts: readonly string[];
    readonly defaultEffort?: string;
    /** 来源:实时目录 / bundled 兜底。 */
    readonly source: 'live' | 'bundled';
}
/** 读到的整份目录。 */
export interface CodebuddyCatalog {
    readonly models: readonly CodebuddyCatalogModel[];
    /** 可被 `--model` 接受的 id(`data.agents[].models`);缺省表示未知,调用方按 models 兜底。 */
    readonly selectable: readonly string[];
    readonly source: 'live' | 'bundled' | 'empty';
}
/** CLI `--effort` 接受的值(`--help`:minimal, low, medium, high, xhigh, max)。 */
export declare const CLI_EFFORTS: readonly string[];
/** 档位展示名。 */
export declare function effortLabel(effort: string): string;
/**
 * 解析倍率:上游给的是字符串 `"x0.11 credits"`,也可能已经是数字。
 * @param raw - `credits` 字段原值。
 * @returns 倍率数值;无法解析(空串、缺字段、路由模型)时 undefined。
 */
export declare function parseCredits(raw: unknown): number | undefined;
/**
 * 倍率展示文本:`x0.11`。
 *
 * 固定两位小数(与 dsh-connect-workbuddy 的选择器标签一致);0 显示 `x0.00`
 * 而不是"免费",因为免费档的判定另由 {@link CodebuddyCatalogModel.free} 承担,
 * 用户在同一个列表里看到的数字要能横向比较。
 * @param rate - 倍率数值。
 * @returns 形如 `x0.11` 的文本。
 */
export declare function formatCredits(rate: number): string;
/**
 * 解析推理档位。上游有两种形状:
 * - 固定档:`{ effort: "high", summary: "auto" }` —— 模型恒用该档,只暴露这一项;
 * - 可选档:`{ supportedEfforts: [...], defaultEffort, canDisableThinking }`。
 * @param raw - `reasoning` 字段原值。
 * @returns 已按 CLI 白名单过滤的档位与默认档。
 */
export declare function parseReasoning(raw: unknown): {
    efforts: string[];
    defaultEffort?: string;
};
/**
 * 原生模态判定。
 *
 * 顺序与 workbuddy 的 `imageDefaultFor` 一致:平台声明 false 一票否决 →
 * 精确 id 白名单 → 其余仅文本。平台声明 true **不构成依据**。
 * @param id - 模型 id。
 * @param platformSupportsImages - 目录里的 `supportsImages`(可能缺失)。
 * @returns 判定结果。
 */
export declare function modalityOf(id: string, platformSupportsImages?: unknown): CodebuddyModality;
/** CodeBuddy 配置目录(`CODEBUDDY_CONFIG_DIR` 与 CLI 自身口径一致)。 */
export declare function codebuddyConfigDir(): string;
/**
 * 读实时目录:`<config>/local_storage/entry_*.info`。
 *
 * 这些 `.info` 是 CLI 登录后写入的缓存,同一目录里还有别的形状(功能开关、
 * base64 大 blob),所以逐个解析后取 `data.models` 最多的一份——那是当前
 * 账号的模型名册。文件缺失/损坏一律当作"没有实时目录",由调用方回退。
 * @param configDir - CodeBuddy 配置目录。
 * @returns 解析结果;没有可用缓存时 undefined。
 */
export declare function readLiveCatalog(configDir?: string): CodebuddyCatalog | undefined;
/**
 * 读 bundled 目录(离线兜底):CLI 安装目录里的 `product*.json`。
 *
 * 只取 id / 展示名 / 窗口 / 档位——**不取 credits**:bundled 倍率会过时
 * (实测 ds41-flash 实时 x0.11 vs bundled x0.00),把旧价写进选择器比不写更糟。
 * 路由型条目(`isDefault: true` 且 `relatedModels` 指向自己)从名册剔除。
 * @param productFiles - `product*.json` 的绝对路径清单。
 * @returns 目录;全部不可读时 undefined。
 */
export declare function readBundledCatalog(productFiles: readonly string[]): CodebuddyCatalog | undefined;
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
export declare function productFilesNear(entryPoints: readonly string[]): string[];
/** 目录快照的读取面(适配器注入;便于测试替换)。 */
export interface CatalogSource {
    /** 当前目录快照(永不抛错;无从读取时返回空目录)。 */
    current(): CodebuddyCatalog;
    /** 强制重读(设置卡"刷新"用)。 */
    invalidate(): void;
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
export declare function createCatalogSource(opts?: {
    live?: () => CodebuddyCatalog | undefined;
    bundled?: () => CodebuddyCatalog | undefined;
    now?: () => number;
}): CatalogSource;
/** 目录快照里按 id 查条目。 */
export declare function findCatalogModel(catalog: CodebuddyCatalog, id: string): CodebuddyCatalogModel | undefined;
/**
 * 选择器展示名:`DeepSeek-V4.1-Flash · x0.11`。
 *
 * 倍率进 name 是刻意的(与 dsh-connect-workbuddy 一致):宿主原样渲染
 * `LlmModelInfo.name`,而 `badge` 只能承载短标签;把价格放进名字是这一栏
 * 唯一能横向比较的位置。没有报价的模型不带后缀,不写"未知"占位。
 * @param model - 目录条目。
 * @returns 展示名。
 */
export declare function catalogModelName(model: CodebuddyCatalogModel): string;
/**
 * 目录条目 → `LlmModelInfo` 的输入模态。
 * @param model - 目录条目。
 * @returns 只含已核实模态的数组。
 */
export declare function catalogInputModalities(model: CodebuddyCatalogModel): readonly ('text' | 'image')[];
/** 目录文件的时间戳(诊断/测试用:最后一次改动时刻)。 */
export declare function catalogMtime(files: readonly string[]): number;
