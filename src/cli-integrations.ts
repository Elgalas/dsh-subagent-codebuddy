/** 把 dsh 的 skill 根接入 CodeBuddy CLI 的用户 skill 目录。 */
import { existsSync, mkdirSync, readdirSync, symlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/**
 * 把 dsh 的全部 skill 根以目录联接接入 CodeBuddy 的用户 skill 目录(幂等)。
 *
 * 覆盖 dsh-skill-filesystem 的默认根(rank 顺序,同名高优先赢,与 dsh 的
 * "winning skill per name" 合并语义一致):
 * | rank | 来源 | 路径 |
 * | 100 | project-dsh | `<projectRoot>/.dsh/skills` |
 * | 200 | project-agents | `<projectRoot>/.agents/skills` |
 * | 400 | user-dsh | `<dshHome>/skills` |
 * | 500 | user-agents | `<agentsHome>/skills` |
 * (custom/bundled 根由部署配置引入,插件侧不可枚举,不在本次接入范围。)
 *
 * 目标已存在(用户手放的同名 skill)时跳过,不覆盖。
 * @param options - 各根的路径覆盖(测试用;projectCwd 决定项目根)。
 * @returns 本次新接入的 skill 名。
 */
export function syncSkillsToCodebuddy(options?: SkillSyncOptions): { linked: string[]; targetDir: string } {
  const target = options?.targetDir ?? join(homedir(), '.codebuddy', 'skills')
  const linked: string[] = []
  // dsh 的同名合并语义:高 rank 根先占名,低 rank 不重复接入(无论其接入成败)。
  const claimed = new Set<string>()
  for (const root of skillRoots(options ?? {})) {
    let entries: string[]
    try {
      entries = readdirSync(root, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name)
    } catch {
      continue
    }
    for (const name of entries) {
      if (claimed.has(name)) continue
      const from = join(root, name)
      if (!existsSync(join(from, 'SKILL.md'))) continue
      claimed.add(name)
      const to = join(target, name)
      if (existsSync(to)) continue
      try {
        mkdirSync(target, { recursive: true })
        symlinkSync(from, to, 'junction')
        linked.push(name)
      } catch { /* 链接失败:跳过该项目 */ }
    }
  }
  return { linked, targetDir: target }
}

/** skill 同步的路径选项。 */
export interface SkillSyncOptions {
  /** 会话工作目录(dsh 的项目根 = 最近含 .git 的祖先;无则用它自身)。 */
  projectCwd?: string
  /** 用户 dsh 根(默认 `$DSH_HOME` 或 `~/.dsh`)。 */
  dshHome?: string
  /** 共享 agents 根(默认 `$DSH_AGENTS_HOME` 或 `~/.agents`)。 */
  agentsHome?: string
  /** CodeBuddy skills 根(默认 `~/.codebuddy/skills`)。 */
  targetDir?: string
}

/** 会话工作目录 → 项目根(最近含 `.git` 的祖先;没有则取自身)。 */
function projectRootOf(cwd: string): string {
  let current = resolve(cwd)
  for (;;) {
    if (existsSync(join(current, '.git'))) return current
    const parent = dirname(current)
    if (parent === current) return resolve(cwd)
    current = parent
  }
}

/** 按 rank 顺序列出要扫描的 skill 根。 */
function skillRoots(options: SkillSyncOptions): string[] {
  const dshHome = options.dshHome ?? process.env['DSH_HOME'] ?? join(homedir(), '.dsh')
  const agentsHome = options.agentsHome ?? process.env['DSH_AGENTS_HOME'] ?? join(homedir(), '.agents')
  const roots: string[] = []
  if (options.projectCwd !== undefined && options.projectCwd.length > 0) {
    const project = projectRootOf(options.projectCwd)
    roots.push(join(project, '.dsh', 'skills'))
    roots.push(join(project, '.agents', 'skills'))
  }
  roots.push(join(dshHome, 'skills'))
  roots.push(join(agentsHome, 'skills'))
  return roots
}
