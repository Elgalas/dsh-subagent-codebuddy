import { createAssistantMessage } from '@deepseek-ai/dsh-llm';
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
export function hasClosingMessage(session, at) {
    const events = session?.ownEvents?.() ?? [];
    return events.some((event) => {
        if (event.type !== 'assistant/message')
            return false;
        if (at === undefined)
            return true;
        const data = event.data;
        return data?.turn === at.turn && data?.step === at.step;
    });
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
export function appendFailureClosingMessage(host, error) {
    if (hasClosingMessage(host.session, host.turnStep))
        return 'already-closed';
    if (host.childHeader?.parentSession === undefined)
        return 'not-subagent';
    const append = host.session?.append;
    const at = host.turnStep;
    if (append === undefined || at === undefined)
        return 'unavailable';
    try {
        append('assistant/message', {
            turn: at.turn,
            step: at.step,
            message: createAssistantMessage({
                content: [{ type: 'text', text: `CodeBuddy 回合失败:${error.message}` }],
                source: { provider: 'codebuddy', model: host.model },
            }),
            stream: [],
        }, { surfaceOp: 'append' });
        return 'appended';
    }
    catch (cause) {
        const log = host.log ?? ((message, detail) => { console.error(message, detail); });
        log(`appendFailureClosingMessage: 补写失败(${cause instanceof Error ? cause.message : String(cause)})`);
        return 'failed';
    }
}
