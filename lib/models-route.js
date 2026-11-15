import { listCodebuddyModelIdsAsync } from './models.js';
import { resolveSpawnableCommand } from './settings.js';
import { catalogModelName, createCatalogSource, findCatalogModel, productFilesNear, readBundledCatalog } from './catalog.js';
function header(headers, name) {
    const value = headers[name];
    return typeof value === 'string' ? value : undefined;
}
/** Normalized URL of a Host-header authority, or undefined when unparsable. */
function parseAuthority(authority) {
    try {
        return new URL(`http://${authority}`);
    }
    catch {
        return undefined;
    }
}
/** Whether the hostname names the local loopback authority. */
function isLoopbackHostname(hostname) {
    if (hostname === 'localhost' || hostname === '[::1]')
        return true;
    const parts = hostname.split('.');
    return parts.length === 4
        && parts[0] === '127'
        && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}
function canonicalAuthority(entry, entryUrl) {
    const port = entryUrl.port !== '' ? entryUrl.port : new URL(`https://${entry}`).port;
    return port === '' ? entryUrl.hostname : `${entryUrl.hostname}:${port}`;
}
function isTrustedAuthority(hostUrl, trustedHosts) {
    return trustedHosts.some((entry) => {
        const entryUrl = parseAuthority(entry);
        if (entryUrl === undefined)
            return false;
        return canonicalAuthority(entry, entryUrl) === entryUrl.hostname
            ? entryUrl.hostname === hostUrl.hostname
            : entryUrl.host === hostUrl.host;
    });
}
/**
 * Whether one request may reach this route: the Host is ours (loopback or a
 * trusted authority) and any attached browser markers are same-origin.
 */
function isTrustedApiRequest(req, trustedHosts) {
    const host = header(req.headers, 'host');
    if (host === undefined)
        return false;
    const hostUrl = parseAuthority(host);
    if (hostUrl === undefined)
        return false;
    if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts))
        return false;
    if (header(req.headers, 'sec-fetch-site') === 'cross-site')
        return false;
    const origin = header(req.headers, 'origin');
    if (origin === undefined)
        return true;
    try {
        return new URL(origin).host === hostUrl.host;
    }
    catch {
        return false;
    }
}
/**
 * 注册模型列表路由。trustedHosts 取自 webStartup(与 --trusted-host 一致);
 * 服务缺失(非 web profile)时不注册。
 * @param ctx - 插件上下文。
 * @param readCommand - 读当前生效的 CodeBuddy 命令(设置面板可改)。
 * @returns 释放函数。
 */
export function registerCodebuddyModelsRoute(ctx, readCommand, catalog = createCatalogSource()) {
    const injectable = ctx;
    if (injectable.inject === undefined)
        return () => { };
    let disposeRoute;
    injectable.inject(['webServer', 'webStartup'], (injected) => {
        const web = injected.get('webServer');
        if (web?.register === undefined)
            return;
        const startup = injected.get('webStartup');
        disposeRoute = web.register({
            kind: 'exact',
            path: '/api/subagent-codebuddy/models',
            handler: (req, res) => { void handle(req, res); },
        });
        async function handle(req, res) {
            const fail = (code, message) => {
                res.writeHead(code, message === undefined ? {} : { 'content-type': 'text/plain' });
                res.end(message ?? '');
            };
            if ((req.method ?? 'GET') !== 'GET')
                return fail(405, 'GET only');
            if (!isTrustedApiRequest(req, startup?.trustedHosts ?? []))
                return fail(403, 'untrusted request');
            const resolved = resolveSpawnableCommand(readCommand());
            try {
                const snapshot = catalog.current();
                const known = snapshot.selectable.length > 0
                    ? [...snapshot.selectable]
                    : snapshot.models.map(model => model.id);
                let ids = known;
                if (ids.length === 0) {
                    // 目录完全不可用(无实时缓存、无 bundled 文件)时才 spawn CLI 探测。
                    const files = productFilesNear([...resolved.args, resolved.command]);
                    const fallback = createCatalogSource({ bundled: () => readBundledCatalog(files) }).current();
                    ids = fallback.models.map(model => model.id);
                    if (ids.length === 0)
                        ids = await listCodebuddyModelIdsAsync(resolved.command, resolved.args);
                }
                res.writeHead(200, { 'content-type': 'application/json' });
                // 名称带倍率与模态后缀:设置卡"获取所有模型"是用户挑默认模型的地方,
                // 价格(与 dsh-connect-workbuddy 同口径)与图片能力都必须在这里可见。
                // `id` 始终是写回设置的真值,`name` 只是展示串(客户端按 id 提交)。
                res.end(JSON.stringify({
                    ok: true,
                    models: ids.map((id) => {
                        const entry = findCatalogModel(snapshot, id);
                        if (entry === undefined)
                            return { id, name: `${id} · 仅文本` };
                        return {
                            id,
                            name: `${catalogModelName(entry)}${entry.modality === 'multimodal' ? ' · 支持图片输入' : ' · 仅文本'}`,
                            credits: entry.credits,
                            contextWindow: entry.contextWindow,
                        };
                    }),
                }));
            }
            catch (error) {
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
            }
        }
    });
    return () => {
        disposeRoute?.();
        disposeRoute = undefined;
    };
}
