/**
 * 子代理模型优先顺序与「配额降级」游标。
 *
 * 背景:CodeBuddy 的配额与计费是**按模型**算的。实测 deepseek-v4.1-flash 吃到
 * `Quota exceeded: 429 … bizCode=6004` 时,hy4free / glm-5.3-flash 仍可正常跑。
 * dsh 的 `GenerateOptions` 一次只给一个 model,所以降级只能由插件自己做:
 * 同一 dsh 回合在**零产出**失败(还没流文本、没发起工具调用)时,换下一个模型
 * 重开一个 CLI 会话(不能 resume——CodeBuddy 的会话与会话模型绑定,换模型
 * resume 会重放旧模型的历史且可能被拒)。
 *
 * 这里只放纯逻辑(顺序合成 + 游标),不做 I/O:顺序规则必须只有一份,
 * pump(何时降级)与 adapter(降级到哪个)都读它。
 * @module subagent-codebuddy/model-plan
 */

/** 一次回合内的模型尝试顺序。 */
export interface ModelPlan {
  /** 实际尝试顺序(已去重;调用方显式指定的模型排在最前)。 */
  readonly models: readonly string[]
  /** 当前模型。 */
  current(): string
  /** 前进到下一个模型;已是最后一个则返回 false 且不改状态。 */
  advance(): boolean
  /** 当前下标(0 起;空计划为 0)。 */
  index(): number
  /** 是否还有下一个模型可换。 */
  hasNext(): boolean
}

/**
 * 合成尝试顺序:显式请求的模型第一,其余按设置里的优先顺序补齐。
 *
 * 显式模型排第一是刻意的——主代理/用户在 `subagent` 调用里点名某个模型时,
 * 那是「这次就用它」;设置里的顺序只用来在它不可用时兜底,不能反过来把
 * 点名模型挤到后面。
 * @param requested - 本次调用实际要用的模型(通常来自 `options.model`,回退默认)。
 * @param configured - 设置里的优先顺序(可能为空)。
 * @returns 去重后的模型顺序;`requested` 为空串时只保留 configured。
 */
export function planModels(requested: string, configured: readonly string[]): string[] {
  const ordered: string[] = []
  const seen = new Set<string>()
  for (const raw of [requested, ...configured]) {
    const id = raw.trim()
    if (id === '' || seen.has(id)) continue
    seen.add(id)
    ordered.push(id)
  }
  return ordered
}

/** 按 {@link planModels} 的顺序建一个游标。 */
export function createModelPlan(requested: string, configured: readonly string[]): ModelPlan {
  const models = planModels(requested, configured)
  let cursor = 0
  return {
    models,
    current: () => models[cursor] ?? requested,
    advance: () => {
      if (cursor + 1 >= models.length) return false
      cursor += 1
      return true
    },
    index: () => cursor,
    hasNext: () => cursor + 1 < models.length,
  }
}
