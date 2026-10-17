'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { readMetadata, releaseFiles, assetNames, checksumName, artifactName, matrices } = require('./release.cjs');

const REPOSITORY = 'chronicle12345/WiFiMeter';
const REPOSITORY_URL = `https://github.com/${REPOSITORY}`;
const API = `https://api.github.com/repos/${REPOSITORY}`;
const USER_AGENT = 'WiFiMeter-public-release-validation';
const repositoryRoot = path.resolve(__dirname, '../..');

class VerificationError extends Error {}

function requireValue(condition, message) {
    if (!condition) throw new VerificationError(message);
}

function downloadPath(tag, name) {
    return `/${REPOSITORY}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
}

function validateDownloadUrl(value, tag, name, repositoryId, base) {
    requireValue(typeof value === 'string' && !/[\\\u0000-\u0020\u007f]/.test(value), '附件下载地址格式无效。');
    let url;
    try { url = new URL(value, base); }
    catch { throw new VerificationError('附件下载地址格式无效。'); }
    requireValue(url.protocol === 'https:' && !url.port && !url.username && !url.password && !url.hash,
        '附件仅允许不含凭据和片段的标准 HTTPS 地址。');
    if (url.hostname === 'github.com') {
        requireValue(url.pathname === downloadPath(tag, name) && !url.search, '附件路径与指定仓库、标签及文件名不一致。');
    } else {
        requireValue(['release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(url.hostname),
            '拒绝未知的附件下载域名。');
        const match = url.pathname.match(/^\/github-production-release-asset(?:-2e65be)?\/(\d+)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
        requireValue(match && match[1] === String(repositoryId), '附件 CDN 路径不属于指定仓库。');
    }
    return url;
}

async function cancelBody(response) {
    try { await response.body?.cancel(); } catch { /* Do not expose signed URLs in transport errors. */ }
}

async function githubJson(url, token, fetch) {
    let response;
    try {
        response = await fetch(url, { redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(30_000),
            headers: { Accept: 'application/vnd.github+json', 'User-Agent': USER_AGENT,
                ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
    } catch { throw new VerificationError('GitHub 发布元数据请求失败。'); }
    const chunks = [];
    let bytes = 0;
    try {
        requireValue(response.status === 200 && !response.redirected && response.body, 'GitHub 发布元数据响应无效。');
        for await (const chunk of response.body) {
            bytes += chunk.byteLength;
            requireValue(bytes <= 1024 * 1024, 'GitHub 发布元数据响应超出大小限制。');
            chunks.push(Buffer.from(chunk));
        }
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (error) {
        if (error instanceof VerificationError) throw error;
        throw new VerificationError('GitHub 发布元数据读取或解析失败。');
    } finally { await cancelBody(response); }
}

async function readExpectedAssets(directory, version) {
    try {
        // Reuse the configured release matrices, including each local binary's manifest hash.
        await releaseFiles(directory, version);
        const expected = new Map();
        for (const [platform, arch] of matrices) {
            const folder = path.join(directory, artifactName(platform, arch));
            const lines = fs.readFileSync(path.join(folder, checksumName(version, platform, arch)), 'utf8').trimEnd().split(/\r?\n/);
            for (const line of lines) {
                const [sha256, name] = line.split('  ');
                expected.set(name, { name, sha256, size: fs.statSync(path.join(folder, name)).size });
            }
        }
        return expected;
    } catch { throw new VerificationError('内部发布附件或 SHA-256 清单验证失败。'); }
}

function validateMetadata(repo, release, tag, expected) {
    requireValue(repo && repo.full_name === REPOSITORY && repo.html_url === REPOSITORY_URL
        && repo.private === false && Number.isSafeInteger(repo.id) && repo.id > 0, '仓库元数据不匹配，或仓库未公开。');
    requireValue(release && release.tag_name === tag && release.html_url === `${REPOSITORY_URL}/releases/tag/${tag}`
        && release.draft === false && release.prerelease === false, 'Release 尚未公开，或标签及发布类型不匹配。');
    requireValue(typeof release.published_at === 'string'
        && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(release.published_at)
        && Number.isFinite(Date.parse(release.published_at)), 'Release 缺少有效的发布时间。');
    requireValue(Array.isArray(release.assets) && release.assets.length === expected.size,
        '公开 Release 必须恰好包含当前发布矩阵的安装包。');
    const remaining = new Set(expected.keys()), assets = new Map();
    for (const asset of release.assets) {
        requireValue(asset && remaining.delete(asset.name), '公开 Release 包含未知或重复附件。');
        const local = expected.get(asset.name);
        requireValue(asset.state === 'uploaded' && Number.isSafeInteger(asset.size) && asset.size > 0
            && asset.size === local.size, `公开附件状态或大小与内部产物不一致：${local.name}`);
        requireValue(asset.browser_download_url === `https://github.com${downloadPath(tag, local.name)}`,
            `公开附件下载路径不匹配：${local.name}`);
        requireValue(asset.digest === `sha256:${local.sha256}`, `公开附件 SHA-256 与内部清单不一致：${local.name}`);
        assets.set(local.name, asset);
    }
    requireValue(remaining.size === 0, '公开 Release 附件不完整。');
    return assets;
}

async function publicResponse(asset, tag, repositoryId, fetch) {
    let url = validateDownloadUrl(asset.browser_download_url, tag, asset.name, repositoryId);
    const visited = new Set(), signal = AbortSignal.timeout(5 * 60_000);
    for (let redirects = 0; redirects <= 5; redirects++) {
        requireValue(!visited.has(url.href), `附件下载发生重复跳转：${asset.name}`);
        visited.add(url.href);
        let response;
        try {
            // The API credential is never passed to an asset or its CDN redirect.
            response = await fetch(url, { redirect: 'manual', credentials: 'omit', signal,
                headers: { Accept: 'application/octet-stream', 'Accept-Encoding': 'identity', 'User-Agent': USER_AGENT } });
        } catch { throw new VerificationError(`公开附件请求失败：${asset.name}`); }
        if (response.redirected) {
            await cancelBody(response);
            throw new VerificationError(`附件发生了非预期的自动跳转：${asset.name}`);
        }
        if ([301, 302, 303, 307, 308].includes(response.status)) {
            const location = response.headers.get('location');
            await cancelBody(response);
            requireValue(location && redirects < 5, `附件跳转缺失或超过次数限制：${asset.name}`);
            url = validateDownloadUrl(location, tag, asset.name, repositoryId, url);
            continue;
        }
        if (response.status !== 200 || !response.body) {
            await cancelBody(response);
            throw new VerificationError(`公开附件响应无效：${asset.name}`);
        }
        return response;
    }
    throw new VerificationError(`附件下载跳转失败：${asset.name}`);
}

async function downloadAsset(asset, tag, repositoryId, fetch) {
    const response = await publicResponse(asset, tag, repositoryId, fetch);
    const hash = createHash('sha256');
    let size = 0;
    try {
        const encoding = response.headers.get('content-encoding');
        requireValue(!encoding || encoding === 'identity', `公开附件响应编码不符合预期：${asset.name}`);
        const length = response.headers.get('content-length');
        requireValue(length === null || (/^\d+$/.test(length) && Number(length) === asset.size),
            `公开附件响应长度不匹配：${asset.name}`);
        for await (const chunk of response.body) {
            size += chunk.byteLength;
            requireValue(size <= asset.size, `公开附件正文超出大小限制：${asset.name}`);
            hash.update(chunk);
        }
        requireValue(size === asset.size, `公开附件实际大小不匹配：${asset.name}`);
        const sha256 = hash.digest('hex');
        requireValue(asset.digest === `sha256:${sha256}`, `公开附件实际 SHA-256 不匹配：${asset.name}`);
        return { name: asset.name, size, sha256 };
    } catch (error) {
        if (error instanceof VerificationError) throw error;
        throw new VerificationError(`公开附件流式读取失败：${asset.name}`);
    } finally { await cancelBody(response); }
}

async function verifyPublicRelease({ directory, version, tag, token, fetch = globalThis.fetch, onAsset } = {}) {
    requireValue(tag === `v${version}`, '公开校验标签必须与当前版本一致。');
    requireValue(!token || (typeof token === 'string' && !/[\r\n]/.test(token)), 'GitHub API 凭据格式无效。');
    const names = matrices.flatMap(([platform, arch]) => assetNames(version, platform, arch));
    requireValue(matrices.length > 0 && names.length > 0 && new Set(names).size === names.length,
        '发布配置必须提供非空矩阵及唯一安装包。');
    const expected = await readExpectedAssets(directory, version);
    const [repo, release] = await Promise.all([
        githubJson(API, token, fetch), githubJson(`${API}/releases/tags/${encodeURIComponent(tag)}`, token, fetch)
    ]);
    const assets = validateMetadata(repo, release, tag, expected), verified = [];
    for (const name of names) {
        const asset = await downloadAsset(assets.get(name), tag, repo.id, fetch);
        verified.push(asset);
        onAsset?.(asset);
    }
    return { passed: true, tag, installerCount: verified.length,
        totalBytes: verified.reduce((sum, asset) => sum + asset.size, 0), assets: verified };
}

async function main(args = process.argv.slice(2), { env = process.env, root = repositoryRoot, fetch = globalThis.fetch,
    onAsset = asset => console.log(JSON.stringify({ name: asset.name, size: asset.size, verified: true })) } = {}) {
    try {
        requireValue(args.length === 1, '请提供已验证的 Actions 发布附件目录。');
        requireValue(env.GITHUB_ACTIONS === 'true' && env.RUNNER_ENVIRONMENT === 'github-hosted',
            '完整公开下载校验仅允许在 GitHub 托管的 Actions runner 执行。');
        requireValue(env.GITHUB_REPOSITORY === REPOSITORY && env.GITHUB_REF_TYPE === 'tag', '公开校验仅允许指定仓库的发布标签。');
        const { version } = readMetadata(root, { refType: 'tag', refName: env.GITHUB_REF_NAME });
        return await verifyPublicRelease({ directory: args[0], version, tag: env.GITHUB_REF_NAME,
            token: env.GH_TOKEN || env.GITHUB_TOKEN, fetch, onAsset });
    } catch (error) {
        if (error instanceof VerificationError) throw error;
        throw new VerificationError('公开发布校验失败，请检查本次标签、版本、双语说明及内部产物。');
    }
}

if (require.main === module) main()
    .then(result => console.log(JSON.stringify(result)))
    .catch(error => { console.error(error.message); process.exitCode = 1; });

module.exports = { verifyPublicRelease, main };
