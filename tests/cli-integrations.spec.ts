/** dsh skill 目录联接测试，全部使用临时目录。 */
import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { syncSkillsToCodebuddy } from '../src/cli-integrations.ts'

const temps: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-int-'))
  temps.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of temps.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* 忽略 */ }
  }
})

describe('syncSkillsToCodebuddy:全部默认根接入', () => {
  it('用户根(dsh/agents)接入目标;含 SKILL.md 才接;幂等', () => {
    const home = tempDir()
    const target = tempDir()
    mkdirSync(join(home, 'dsh', 'skills', 'ponytail'), { recursive: true })
    writeFileSync(join(home, 'dsh', 'skills', 'ponytail', 'SKILL.md'), '---\nname: ponytail\n---\nbody\n')
    mkdirSync(join(home, 'dsh', 'skills', 'not-a-skill'), { recursive: true })
    mkdirSync(join(home, 'agents', 'skills', 'shared'), { recursive: true })
    writeFileSync(join(home, 'agents', 'skills', 'shared', 'SKILL.md'), 'from agents')

    const paths = {
      dshHome: join(home, 'dsh'),
      agentsHome: join(home, 'agents'),
      targetDir: target,
    }
    const first = syncSkillsToCodebuddy(paths)
    expect([...first.linked].sort()).toEqual(['ponytail', 'shared'])
    // 接入后从目标侧可读到内容(联接生效)。
    expect(readFileSync(join(target, 'ponytail', 'SKILL.md'), 'utf8')).toContain('name: ponytail')
    expect(readFileSync(join(target, 'shared', 'SKILL.md'), 'utf8')).toBe('from agents')
    // 无 SKILL.md 的目录不接入。
    expect(() => readlinkSync(join(target, 'not-a-skill'))).toThrow()

    // 幂等:第二次不再重复接入。
    expect(syncSkillsToCodebuddy(paths).linked).toEqual([])
  })

  it('项目根优先:同名时项目 skill 赢(user 根不覆盖)', () => {
    const home = tempDir()
    const target = tempDir()
    const project = join(home, 'proj')
    mkdirSync(join(project, '.git'), { recursive: true })
    mkdirSync(join(project, '.dsh', 'skills', 'ponytail'), { recursive: true })
    writeFileSync(join(project, '.dsh', 'skills', 'ponytail', 'SKILL.md'), 'from-project')
    mkdirSync(join(home, 'dsh', 'skills', 'ponytail'), { recursive: true })
    writeFileSync(join(home, 'dsh', 'skills', 'ponytail', 'SKILL.md'), 'from-user')

    const result = syncSkillsToCodebuddy({
      projectCwd: project,
      dshHome: join(home, 'dsh'),
      agentsHome: join(home, 'agents'),
      targetDir: target,
    })
    expect(result.linked).toEqual(['ponytail'])
    expect(readFileSync(join(target, 'ponytail', 'SKILL.md'), 'utf8')).toBe('from-project')
  })

  it('目标已存在同名目录(用户手放)时不覆盖', () => {
    const home = tempDir()
    const target = tempDir()
    mkdirSync(join(home, 'dsh', 'skills', 'ponytail'), { recursive: true })
    writeFileSync(join(home, 'dsh', 'skills', 'ponytail', 'SKILL.md'), 'from-dsh')
    mkdirSync(join(target, 'ponytail'), { recursive: true })
    writeFileSync(join(target, 'ponytail', 'SKILL.md'), 'user-owned')

    const result = syncSkillsToCodebuddy({ dshHome: join(home, 'dsh'), agentsHome: join(home, 'agents'), targetDir: target })
    expect(result.linked).toEqual([])
    expect(readFileSync(join(target, 'ponytail', 'SKILL.md'), 'utf8')).toBe('user-owned')
  })
})
