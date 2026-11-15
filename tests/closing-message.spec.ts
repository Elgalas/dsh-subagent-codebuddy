/**
 * 「临终遗言」的落盘契约。
 *
 * 事故链(2026-11-14 取证):子代理因配额/401 硬失败 → agent-loop 只留下
 * `assistant/attempt`(finish error),**没有 assistant/message** → dsh 结算通知
 * 只带"failed before it finished / It left no closing message",失败原因整条丢失。
 * 插件有补写逻辑,但 `Session.append` 对 surface-eligible 事件要求
 * `surfaceOp: 'append'` marker,缺省时抛错,而补写路径用空 catch 吞掉 →
 * 补写从未落盘。
 *
 * 这里用**真的** `@deepseek-ai/dsh-session` 跑同一条写入路径:假的 session 面
 * 测不出 marker 校验(历史教训:旧单测全绿但线上静默失败)。
 */
import { describe, expect, it, vi } from 'vitest'
import { Session, isSurfaceEligibleType } from '@deepseek-ai/dsh-session'
import { appendFailureClosingMessage, hasClosingMessage } from '../src/closing-message.ts'
import type { ClosingMessageSession } from '../src/closing-message.ts'

const SUBAGENT_HEADER = {
  version: 4,
  id: 'probe-child',
  createdAt: Date.now(),
  isSeeded: false,
  cwd: '/tmp',
  parentSession: 'probe-parent',
  origin: 'subagent',
  delegationDepth: 1,
  agentPreset: 'ops-ptc',
} as const

/** 建一个真会话,并开好 turn/step(与 adapter 的 findOpenStep 对齐)。 */
function realChildSession(): Session {
  const session = Session.create('probe-child', [], { ...SUBAGENT_HEADER })
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  return session
}

/** adapter 转发给泵的那层薄面(marker 必须透传,否则写入抛错)。 */
function faceOf(session: Session): ClosingMessageSession {
  return {
    ownEvents: () => session.ownEvents(),
    append: (type, data, opts) => session.append(type, data, opts),
  }
}

describe('assistant/message 的 surfaceOp 契约', () => {
  it('assistant/message 是 surface-eligible 事件', () => {
    expect(isSurfaceEligibleType('assistant/message')).toBe(true)
    expect(isSurfaceEligibleType('turn/start')).toBe(false)
  })

  it('缺 surfaceOp marker 时真 Session 直接抛错(旧实现的静默失败点)', () => {
    const session = realChildSession()
    expect(() => session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: { id: 'm1', role: 'assistant', source: { kind: 'model', provider: 'codebuddy', model: 'glm-5.3' }, content: [] },
      stream: [],
    })).toThrow(/requires a surfaceOp marker/)
  })
})

describe('appendFailureClosingMessage', () => {
  it('子会话零产出失败 → 真会话里落一条含原因的 assistant/message', () => {
    const session = realChildSession()
    const outcome = appendFailureClosingMessage({
      session: faceOf(session),
      turnStep: { turn: 1, step: 1 },
      childHeader: { parentSession: 'probe-parent' },
      model: 'deepseek-v4.1-flash',
    }, new Error('CodeBuddy 中断:账号受限(限流/配额不足)——Quota exceeded: 429'))

    expect(outcome).toBe('appended')
    const messages = session.ownEvents().filter(event => event.type === 'assistant/message')
    expect(messages).toHaveLength(1)
    const data = messages[0]?.data as {
      turn: number
      step: number
      message: { content: readonly { type: string; text?: string }[] }
    }
    expect(data.turn).toBe(1)
    expect(data.step).toBe(1)
    const text = data.message.content.map(block => block.text ?? '').join('')
    expect(text).toContain('CodeBuddy 回合失败')
    expect(text).toContain('Quota exceeded: 429')
    // 落盘后 must 能被"已有收尾消息"的判据看到(幂等的另一半)。
    expect(hasClosingMessage(faceOf(session), { turn: 1, step: 1 })).toBe(true)
  })

  it('本回合已有收尾消息 → 不补(幂等)', () => {
    const session = realChildSession()
    const host = {
      session: faceOf(session),
      turnStep: { turn: 1, step: 1 },
      childHeader: { parentSession: 'probe-parent' },
      model: 'glm-5.3',
    }
    appendFailureClosingMessage(host, new Error('boom'))
    expect(appendFailureClosingMessage(host, new Error('boom again'))).toBe('already-closed')
    expect(session.ownEvents().filter(event => event.type === 'assistant/message')).toHaveLength(1)
  })

  it('主会话(无 parentSession)→ 不补', () => {
    const session = realChildSession()
    const outcome = appendFailureClosingMessage({
      session: faceOf(session),
      turnStep: { turn: 1, step: 1 },
      childHeader: {},
      model: 'glm-5.3',
    }, new Error('boom'))
    expect(outcome).toBe('not-subagent')
    expect(session.ownEvents().some(event => event.type === 'assistant/message')).toBe(false)
  })

  it('拿不到回合位置或写通道 → 明确报告 unavailable(不再静默)', () => {
    const session = realChildSession()
    expect(appendFailureClosingMessage({
      session: faceOf(session),
      childHeader: { parentSession: 'probe-parent' },
      model: 'glm-5.3',
    }, new Error('boom'))).toBe('unavailable')
    expect(appendFailureClosingMessage({
      session: { ownEvents: () => [] },
      turnStep: { turn: 1, step: 1 },
      childHeader: { parentSession: 'probe-parent' },
      model: 'glm-5.3',
    }, new Error('boom'))).toBe('unavailable')
  })

  it('写盘抛错 → 返回 failed 且留下日志(不吞)', () => {
    const log = vi.fn()
    const outcome = appendFailureClosingMessage({
      session: { ownEvents: () => [], append: () => { throw new Error('disk full') } },
      turnStep: { turn: 1, step: 1 },
      childHeader: { parentSession: 'probe-parent' },
      model: 'glm-5.3',
      log,
    }, new Error('boom'))
    expect(outcome).toBe('failed')
    expect(log).toHaveBeenCalledTimes(1)
    expect(String(log.mock.calls[0]?.[0])).toContain('disk full')
  })
})
