/**
 * 模型优先顺序与配额降级游标(纯逻辑)。
 *
 * 这层只在「哪个模型先试、失败后换谁」上做决定,不碰 ACP/进程;
 * 契约一旦错位,pump 会把同一模型反复重启(旧行为的 bug 形态)。
 */
import { describe, expect, it } from 'vitest'
import { createModelPlan, planModels } from '../src/model-plan.ts'

describe('planModels', () => {
  it('显式请求的模型排第一,其余按设置顺序补齐', () => {
    expect(planModels('hy4free', ['deepseek-v4.1-flash', 'hy4free', 'glm-5.3']))
      .toEqual(['hy4free', 'deepseek-v4.1-flash', 'glm-5.3'])
  })

  it('去重且剔除空串', () => {
    expect(planModels(' a ', ['a', '', '  ', 'b', 'b'])).toEqual(['a', 'b'])
  })

  it('没有显式模型时只保留设置顺序', () => {
    expect(planModels('', ['hy4free', 'glm-5.3'])).toEqual(['hy4free', 'glm-5.3'])
  })

  it('设置顺序为空时只有显式模型', () => {
    expect(planModels('hy4free', [])).toEqual(['hy4free'])
  })
})

describe('createModelPlan', () => {
  it('游标从 0 开始,advance 逐个前进到尽头', () => {
    const plan = createModelPlan('deepseek-v4.1-flash', ['deepseek-v4.1-flash', 'hy4free'])
    expect(plan.current()).toBe('deepseek-v4.1-flash')
    expect(plan.index()).toBe(0)
    expect(plan.hasNext()).toBe(true)
    expect(plan.advance()).toBe(true)
    expect(plan.current()).toBe('hy4free')
    expect(plan.hasNext()).toBe(false)
    expect(plan.advance()).toBe(false)
    // 到尽头后不改状态:仍停在最后一个模型。
    expect(plan.current()).toBe('hy4free')
    expect(plan.index()).toBe(1)
  })

  it('单模型计划没有可换的下一个', () => {
    const plan = createModelPlan('hy4free', ['hy4free'])
    expect(plan.hasNext()).toBe(false)
    expect(plan.advance()).toBe(false)
    expect(plan.current()).toBe('hy4free')
  })

  it('计划为空时回落到请求的模型', () => {
    const plan = createModelPlan('', [])
    expect(plan.models).toEqual([])
    expect(plan.current()).toBe('')
    expect(plan.advance()).toBe(false)
  })
})
