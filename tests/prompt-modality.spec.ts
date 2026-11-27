/**
 * 读图引导分流测试:读图走 CLI 原生 ViewImage(已放行;MCP 工具结果的图片会被
 * CLI 按模型能力过滤,只有内置读图通道不过滤)。2026-11-25 实测:CLI 的 Read
 * 对图片只回"请用 ViewImage 工具查看",解图由 ViewImage 完成。AGY 转述仅兜底或用户显式要求;
 * 工具缺席时如实说明——尾注(promptTailFor)与 system 位
 * (systemInstructionsText)两侧口径一致。
 */
import { describe, expect, it } from 'vitest'
import { imageGuidanceFrom } from '../src/adapter.ts'
import { promptTailFor } from '../src/pump.ts'
import { systemInstructionsText } from '../src/serialize.ts'

describe('promptTailFor(读图引导)', () => {
  it('原生:指 ViewImage 工具,AGY 转述仅用户要求', () => {
    const delegate = promptTailFor('delegate', 'native')
    expect(delegate).toContain('读图片用 ViewImage 工具')
    expect(delegate).not.toContain('读图片用 Read 工具')
    expect(delegate).toContain('除非用户明确要求')
    expect(delegate).not.toContain('读图片用 dsh_read_image_agy——')

    const mcp = promptTailFor('mcp', 'native')
    expect(mcp).toContain('读图片用 ViewImage 工具')
    expect(mcp).not.toContain('读图片用 Read 工具')
  })

  it('AGY 兜底:指 read_image_agy 并说明没有原生读图工具', () => {
    const delegate = promptTailFor('delegate', 'agy')
    expect(delegate).toContain('读图片用 dsh_read_image_agy')
    expect(delegate).toContain('本会话没有可用的原生读图工具')
    expect(delegate).not.toContain('会被拒绝')

    const mcp = promptTailFor('mcp', 'agy')
    expect(mcp).toContain('读图片用 mcp__dsh__read_image_agy')
  })

  it('工具缺席:如实说明,不指路不存在的工具', () => {
    const note = promptTailFor('delegate', 'unavailable')
    expect(note).toContain('没有可用的读图工具')
    expect(note).not.toContain('dsh_read_image_agy')
  })

  it('缺省 guidance = native(保持旧文案)', () => {
    expect(promptTailFor('delegate')).toBe(promptTailFor('delegate', 'native'))
    expect(promptTailFor('mcp')).toBe(promptTailFor('mcp', 'native'))
  })
})

describe('systemInstructionsText(读图引导)', () => {
  it('原生:system 位同样指 ViewImage(与桥接模式无关)', () => {
    const text = systemInstructionsText('SYS', false, 'mcp', 'native')
    expect(text).toContain('SYS')
    expect(text).toContain('读图片用 ViewImage 工具')
    expect(text).not.toContain('读图片用 Read 工具')
    expect(text).not.toContain('会被拒绝')

    expect(systemInstructionsText('SYS', false, 'delegate', 'native')).toContain('读图片用 ViewImage 工具')
  })

  it('AGY 兜底:system 位指 read_image_agy 并说明没有原生读图工具', () => {
    const text = systemInstructionsText('SYS', false, 'mcp', 'agy')
    expect(text).toContain('读图片用 mcp__dsh__read_image_agy')
    expect(text).toContain('本会话没有可用的原生读图工具')
    expect(text).not.toContain('原生支持图片输入')
  })

  it('工具缺席:如实说明', () => {
    const text = systemInstructionsText('SYS', false, 'delegate', 'unavailable')
    expect(text).toContain('没有可用的读图工具')
  })
})

describe('imageGuidanceFrom(档位判定)', () => {
  /** 判定入参默认值:普通会话 + tools 服务在场但两个读图工具都查不到。 */
  const facts = {
    ptcOnly: false,
    readImage: false,
    agy: false,
    toolsUnavailable: false,
    modelImageCapable: true,
  }

  it('非 PTC 恒 native:子代理作用域查不到 read_image 也不降级', () => {
    // 2026-11-27 实测:子代理能调 mcp__dsh__read_image,宿主平面却查不到,
    // 旧逻辑据此判 unavailable,尾注与本会话实际能力自相矛盾。
    expect(imageGuidanceFrom(facts)).toBe('native')
    expect(imageGuidanceFrom({ ...facts, modelImageCapable: false })).toBe('native')
  })

  it('PTC:ViewImage 已禁,按 dsh read_image 在场分级', () => {
    expect(imageGuidanceFrom({ ...facts, ptcOnly: true, readImage: true })).toBe('native')
    expect(imageGuidanceFrom({ ...facts, ptcOnly: true, agy: true })).toBe('agy')
    expect(imageGuidanceFrom({ ...facts, ptcOnly: true })).toBe('unavailable')
  })

  it('PTC 且 tools 服务缺席:按模型能力兜底', () => {
    expect(imageGuidanceFrom({ ...facts, ptcOnly: true, toolsUnavailable: true })).toBe('native')
    expect(imageGuidanceFrom({ ...facts, ptcOnly: true, toolsUnavailable: true, modelImageCapable: false }))
      .toBe('unavailable')
  })
})
