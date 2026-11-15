/**
 * CodeBuddy 方言测试:`--mcp-config` 文件生成与陈旧文件清扫。
 *
 * 通用面(端点、工具执行、断连补投)在共享包 @elgalas/dsh-mcp-tool-server 的
 * tests/mcp-server.spec.ts;这里只测本插件保留的落盘形态。
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { registerDshMcpServer } from '@elgalas/dsh-mcp-tool-server'
import { mcpConfigArgs, sweepStaleMcpConfigs } from '../src/mcp-config.ts'

let disposeServer: (() => void) | undefined
afterEach(() => {
  disposeServer?.()
  disposeServer = undefined
})

/** 最小 ctx:只满足 registerDshMcpServer 的 webServer 注入面。 */
function makeCtx(): Context {
  return {
    get: () => undefined,
    inject: (_deps: string[], fn: (injected: Context) => (() => void) | void): { dispose: () => void } => {
      const disposer = fn({
        get: (key: string): unknown => key === 'webServer'
          ? { register: () => () => {}, port: 0 }
          : undefined,
      } as unknown as Context)
      return { dispose: () => { disposer?.() } }
    },
  } as unknown as Context
}

describe('--mcp-config 文件(CodeBuddy 方言)', () => {
  it('严格模式仅传入会话专属端点，URL 带 session/key 且工具直连', () => {
    // 自建端点:不依赖前序用例残留的模块级 endpoint。
    disposeServer = registerDshMcpServer(makeCtx())
    const args = mcpConfigArgs('mcp', 'sess-x')
    expect(args.slice(0, 2)).toEqual(['--strict-mcp-config', '--mcp-config'])
    const config = JSON.parse(readFileSync(args[2]!, 'utf8')) as {
      mcpServers: { dsh: { type: string; url: string; defer_loading?: boolean } }
    }
    expect(Object.keys(config.mcpServers)).toEqual(['dsh'])
    const server = config.mcpServers.dsh
    // 全部工具直接展开(显式 false,防止被 CLI 全局 defer 开关覆盖成延迟加载)。
    expect(server.defer_loading).toBe(false)
    const url = new URL(server.url)
    expect(url.searchParams.get('session')).toBe('sess-x')
    expect((url.searchParams.get('key') ?? '').length).toBeGreaterThan(10)
  })

  it('delegate、辅助调用或端点不可用时仍显式传入严格空配置', () => {
    const empty = ['--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}']
    expect(mcpConfigArgs('delegate', 'sess-x')).toEqual(empty)
    expect(mcpConfigArgs()).toEqual(empty)
    expect(mcpConfigArgs('mcp', 'sess-no-endpoint')).toEqual(empty)
  })

  it('sweepStaleMcpConfigs:只删超龄的 mcp- 文件,不动新文件与其他文件', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-mcp-sweep-'))
    try {
      const stale = join(dir, 'mcp-stale.json')
      const fresh = join(dir, 'mcp-fresh.json')
      const other = join(dir, 'keep.txt')
      writeFileSync(stale, '{}')
      writeFileSync(fresh, '{}')
      writeFileSync(other, '{}')
      const past = (Date.now() - 2 * 60 * 60 * 1000) / 1000
      utimesSync(stale, past, past)
      utimesSync(other, past, past)
      expect(sweepStaleMcpConfigs(dir, 60 * 60 * 1000)).toBe(1)
      expect(readdirSync(dir).sort()).toEqual(['keep.txt', 'mcp-fresh.json'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
