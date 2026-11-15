/**
 * 插件配置 schema 的回归:设置页写入的键必须被 schema 接受,
 * 默认值也必须与卡片展示的行为一致(空 models = 用 model 单条)。
 *
 * 注意:`.volatile()` 字段在没有 settings 上下文时解析成取值器
 * (`{ get, [volatile.write] }`),所以断言前要先 resolve。
 */
import { describe, expect, it } from 'vitest'
import { Config } from '../src/index.ts'

/** schemastery 的实例本身可调用(value in → 解析结果)。 */
const parse = (input: Record<string, unknown>): Record<string, unknown> =>
  (Config as unknown as (value: Record<string, unknown>) => Record<string, unknown>)(input)

/** volatile 字段解析后是 `{ get }` 取值器;普通字段就是值。 */
function value(field: unknown): unknown {
  if (typeof field === 'object' && field !== null && typeof (field as { get?: unknown }).get === 'function') {
    return (field as { get: () => unknown }).get()
  }
  return field
}

describe('Config schema', () => {
  it('默认:单一模型、不指定思考强度、配额降级开启', () => {
    const parsed = parse({})
    expect(value(parsed.model)).toBe('deepseek-v4.1-flash')
    expect(value(parsed.models)).toEqual([])
    expect(value(parsed.defaultEffort)).toBe('')
    expect(value(parsed.fallbackOnQuota)).toBe(true)
  })

  it('接受优先顺序数组与思考强度', () => {
    const parsed = parse({
      models: ['deepseek-v4.1-flash', 'hy4free'],
      defaultEffort: 'high',
      fallbackOnQuota: false,
    })
    expect(value(parsed.models)).toEqual(['deepseek-v4.1-flash', 'hy4free'])
    expect(value(parsed.defaultEffort)).toBe('high')
    expect(value(parsed.fallbackOnQuota)).toBe(false)
  })
})
