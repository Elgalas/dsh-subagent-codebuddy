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
export declare function syncSkillsToCodebuddy(options?: SkillSyncOptions): {
    linked: string[];
    targetDir: string;
};
/** skill 同步的路径选项。 */
export interface SkillSyncOptions {
    /** 会话工作目录(dsh 的项目根 = 最近含 .git 的祖先;无则用它自身)。 */
    projectCwd?: string;
    /** 用户 dsh 根(默认 `$DSH_HOME` 或 `~/.dsh`)。 */
    dshHome?: string;
    /** 共享 agents 根(默认 `$DSH_AGENTS_HOME` 或 `~/.agents`)。 */
    agentsHome?: string;
    /** CodeBuddy skills 根(默认 `~/.codebuddy/skills`)。 */
    targetDir?: string;
}
