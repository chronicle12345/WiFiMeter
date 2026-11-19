'use strict';

// Minimal WebDAV client for backup files: one flat collection, Basic authentication.
const REQUEST_TIMEOUT = 60000;

function createWebdavClient({ url, username = '', password = '', fetch: fetchImpl = globalThis.fetch, timeout = REQUEST_TIMEOUT }) {
    let base;
    try { base = new URL(url); } catch { throw Error('WebDAV 地址无效。'); }
    if (!['https:', 'http:'].includes(base.protocol)) throw Error('WebDAV 地址必须以 https:// 或 http:// 开头。');
    if (base.username || base.password) throw Error('请在用户名和密码栏填写账号，不要写在地址里。');
    if (!base.pathname.endsWith('/')) base.pathname += '/';
    const authorization = username || password ? 'Basic ' + Buffer.from(`${username}:${password}`, 'utf8').toString('base64') : '';

    async function send(method, name = '', { body, headers = {}, accept = [] } = {}) {
        let response;
        try {
            response = await fetchImpl(new URL(encodeURIComponent(name), base), { method, body, redirect: 'error',
                signal: AbortSignal.timeout(timeout), headers: { ...(authorization ? { Authorization: authorization } : {}), ...headers } });
        } catch (error) {
            throw Error(error.name === 'TimeoutError' ? 'WebDAV 服务器响应超时。' : `无法连接 WebDAV 服务器：${error.cause?.message || error.message}`);
        }
        if (response.ok || accept.includes(response.status)) return response;
        if (response.status === 401 || response.status === 403) throw Error('WebDAV 用户名或密码不正确，或没有访问权限。');
        if (response.status === 404) throw Error('WebDAV 上找不到这个目录或文件。');
        if (response.status === 507) throw Error('WebDAV 存储空间不足。');
        throw Error(`WebDAV 服务器返回 ${response.status}。`);
    }

    return {
        // Creates the collection when it is missing; 405 means it already exists.
        async ensureDirectory() { await send('MKCOL', '', { accept: [405] }); },
        async list() {
            const response = await send('PROPFIND', '', { headers: { Depth: '1', 'Content-Type': 'application/xml' },
                body: '<?xml version="1.0"?><propfind xmlns="DAV:"><prop><getcontentlength/><getlastmodified/></prop></propfind>' });
            return parseListing(await response.text(), base.pathname);
        },
        async upload(name, bytes) { await send('PUT', name, { body: bytes, headers: { 'Content-Type': 'application/octet-stream' } }); },
        async download(name, maxBytes) {
            const response = await send('GET', name);
            const declared = Number(response.headers.get('content-length'));
            if (declared > maxBytes) throw Error('远端备份过大，未下载。');
            const bytes = Buffer.from(await response.arrayBuffer());
            if (bytes.length > maxBytes) throw Error('远端备份过大，未下载。');
            return bytes;
        },
        async remove(name) { await send('DELETE', name, { accept: [404] }); }
    };
}

// Reads file names, sizes and modification times from a multistatus response, skipping the collection itself.
function parseListing(xml, basePath) {
    const files = [];
    for (const [, block] of xml.matchAll(/<(?:[\w-]+:)?response[\s>]([\s\S]*?)<\/(?:[\w-]+:)?response>/gi)) {
        const href = /<(?:[\w-]+:)?href[^>]*>([^<]*)</i.exec(block)?.[1]?.trim();
        if (!href || /<(?:[\w-]+:)?collection\s*\/?>/i.test(block)) continue;
        let pathname;
        try { pathname = decodeURIComponent(new URL(href, 'http://host').pathname); } catch { continue; }
        if (pathname.endsWith('/') || !pathname.startsWith(decodeURIComponent(basePath))) continue;
        const name = pathname.slice(pathname.lastIndexOf('/') + 1);
        const modified = Date.parse(/<(?:[\w-]+:)?getlastmodified[^>]*>([^<]*)</i.exec(block)?.[1] ?? '');
        files.push({ name, size: Number(/<(?:[\w-]+:)?getcontentlength[^>]*>(\d+)</i.exec(block)?.[1] ?? 0),
            modifiedAt: Number.isFinite(modified) ? new Date(modified).toISOString() : '' });
    }
    return files;
}

module.exports = { createWebdavClient, parseListing };
