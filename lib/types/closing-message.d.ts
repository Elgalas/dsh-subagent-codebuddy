/**
 * 子代理会话的「临终遗言」:零产出失败时补一条 assistant 文本,让失败原因随
 * dsh 的结算通知回到主代理。
 *
 * **为什么必须补**(2026-09-21 实测):dsh 的通知构造
 * (`dsh-subagent/src/continuation-messages.ts`)只带一句通用结论 + 子代理**最后
 * 一条 assistant 消息**;而硬失败(401/配额/传输错)时 agent-loop 直接
 * `throw LlmError`,不产生 assistant 消息 → 主代理只收到
 * "Background subagent X failed before it finished. / It left no closing
 * message.",失败原因整条丢失。
 *
 * **为什么抽成纯函数**(2026-11-14):过去的 `try/catch {}` 把写入失败吞成静默
 * no-op;用真 `Session` 写回归测试才发现 `surfaceOp` 必填。这个模块让同一条
 * 路径可以被真会话、假会话和单测三方复用。
 */
/** 会话面(只取本模块用到的两件事:读事件、写事件)。 */
export interface ClosingMessageSession {
    ownEvents?: () => readonly {
        type: string;
        data?: unknown;
    }[];
    append?: (type: string, data: unknown, opts?: {
        surfaceOp?: 'append';
    }) => unknown;
}
/** 本回合的位置(与 `step/start` 配对)。 */
export interface ClosingMessageTurnStep {
    turn: number;
    step: number;
}
export type ClosingMessageOutcome = 
/** 本回合已有 `assistant/message`(loop 先写后抛),不再补。 */
'already-closed'
/** 不是子会话(主会话失败有自己的失败卡),不补。 */
 | 'not-subagent'
/** 拿不到可写通道或回合位置,补写无从下手。 */
 | 'unavailable'
/** 已补写。 */
 | 'appended'
/** 补写抛错(只记日志,不改变失败语义)。 */
 | 'failed';
/**
 * 本回合是否已经落了 `assistant/message`(收尾消息)。
 *
 * **为什么不能用"流式文本"代替**(2026-11-14 旧会话取证):子代理被宿主判
 * `ModelBehaviorError` 时,agent-loop 抛错前可能已经把流式文本记成
 * `assistant/attempt`、却**没有任何 assistant/message**;旧闸门
 * `if (this.hasText) return` 因此跳过补写,结算通知只剩 "It left no closing
 * message"。判据必须落在"有没有 message 事件"上,而不是"有没有流过字"。
 *
 * @param session - 子会话面。
 * @param at - 本回合位置;未知时任一收尾消息即算已有。
 * @returns 是否已有本回合的收尾消息。
 */
export declare function hasClosingMessage(session: ClosingMessageSession | undefined, at: ClosingMessageTurnStep | undefined): boolean;
/** 补写所需的宿主信息。 */
export interface ClosingMessageHost {
    /** 会话面;sessions 服务拿不到时为 undefined。 */
    session?: ClosingMessageSession;
    /** 本回合位置(来自 `findOpenStep`,缺省则无法对齐事件)。 */
    turnStep?: ClosingMessageTurnStep;
    /** 子会话头(`parentSession` 存在才补写)。 */
    childHeader?: {
        parentSession?: string;
    };
    /** 失败回合所用的模型 id(写进消息 source)。 */
    model: string;
    /** 诊断日志(默认 console.error)。 */
    log?: (message: string, detail?: unknown) => void;
}
/**
 * 补写失败收尾消息。
 *
 * 三道闸门(顺序即语义):
 * 1. 本回合已有收尾消息 → 不补(幂等,避免覆盖 loop 自己写的消息)。
 * 2. 不是子会话(`childHeader.parentSession` 缺失)→ 不补(主会话有自己的失败卡)。
 * 3. 可写通道或回合位置缺失 → 无法补。
 *
 * **`surfaceOp: 'append'` 不可省**:`assistant/message` 属于 surface-eligible
 * 事件,dsh-session 的 `Session.append` 在缺省 marker 时抛
 * `session event "assistant/message" is surface-eligible and requires a
 * surfaceOp marker`(0.2.2-rc.3 实测)。旧实现不带 opts 又用空 catch 吞掉,
 * 于是"补写"从未真正落盘——这就是旧会话里主代理只看到 "It left no closing
 * message" 的直接原因。
 *
 * @param host - 宿主信息(会话面、回合位置、子会话头、模型)。
 * @param error - 触发失败的原始错误(文本写进收尾消息)。
 * @returns 本函数走了哪条分支。
 */
export declare function appendFailureClosingMessage(host: ClosingMessageHost, error: Error): ClosingMessageOutcome;
