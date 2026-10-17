'use strict';
const fs = require('node:fs');

const workflowPath = '.github/workflows/tauri.yml';
const requiredJobs = [
    'Workflow checks and Tauri release metadata',
    'Windows browser UI shard 1/2', 'Windows browser UI shard 2/2',
    // 'Linux browser UI shard 1/2', 'Linux browser UI shard 2/2',
    'Windows x64 Tauri',
    // 'Windows ia32 Tauri', 'Windows arm64 Tauri',
    // 'Linux x64 Tauri', 'Linux arm64 Tauri',
    'Required Tauri checks'
];
const requiredArtifacts = [
    'tauri-release-windows-x64',
    // 'tauri-release-windows-ia32', 'tauri-release-windows-arm64',
    // 'tauri-release-linux-x64', 'tauri-release-linux-arm64'
];
const positiveId = value => Number.isSafeInteger(value) && value > 0;

async function findValidatedRun({ repository, sha, refType, token, fetchImpl = globalThis.fetch }) {
    if (refType !== 'tag') return '';
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || '') ||
        !/^[a-f0-9]{40}$/.test(sha || '') || !token) return '';

    // API 失败仅表示无法复用；标签仍执行完整构建。错误正文和凭据不进入日志。
    try {
        const base = `https://api.github.com/repos/${repository}/actions`;
        async function request(endpoint) {
            const response = await fetchImpl(`${base}/${endpoint}`, {
                method: 'GET', redirect: 'error', signal: AbortSignal.timeout(15000),
                headers: {
                    Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`,
                    'X-GitHub-Api-Version': '2022-11-28'
                }
            });
            if (!response.ok) throw new Error('GitHub API request failed');
            return response.json();
        }
        async function list(endpoint, field, query) {
            const values = [];
            for (let page = 1; page <= 10; page++) {
                const params = new URLSearchParams({ ...query, per_page: '100', page: String(page) });
                const result = await request(`${endpoint}?${params}`);
                if (!Number.isSafeInteger(result?.total_count) || result.total_count < 0 ||
                    !Array.isArray(result[field]) || result[field].length > 100) throw new Error('Invalid GitHub list');
                values.push(...result[field]);
                if (values.length === result.total_count) return values;
                if (!result[field].length || values.length > result.total_count) throw new Error('Incomplete GitHub list');
            }
            throw new Error('GitHub list exceeds search limit');
        }

        const workflow = await request('workflows/tauri.yml');
        if (!positiveId(workflow?.id) || workflow.path !== workflowPath) return '';
        const runs = await list(`workflows/${workflow.id}/runs`, 'workflow_runs', {
            event: 'push', branch: 'main', head_sha: sha, status: 'success'
        });
        for (const run of runs) {
            if (!positiveId(run?.id) || run.workflow_id !== workflow.id || run.path !== workflowPath ||
                run.event !== 'push' || run.head_branch !== 'main' || run.head_sha !== sha ||
                run.status !== 'completed' || run.conclusion !== 'success' ||
                run.repository?.full_name !== repository || run.head_repository?.full_name !== repository ||
                !positiveId(run.repository?.id) || run.head_repository.id !== run.repository.id) continue;
            const jobs = await list(`runs/${run.id}/jobs`, 'jobs', { filter: 'latest' });
            if (!requiredJobs.every(name => {
                const matching = jobs.filter(job => job?.name === name);
                return matching.length === 1 && matching[0].run_id === run.id && matching[0].head_sha === sha &&
                    matching[0].status === 'completed' && matching[0].conclusion === 'success';
            })) continue;
            const artifacts = await list(`runs/${run.id}/artifacts`, 'artifacts', {});
            const releaseArtifacts = artifacts.filter(artifact => artifact?.name?.startsWith('tauri-release-'));
            if (releaseArtifacts.length !== requiredArtifacts.length) continue;
            if (requiredArtifacts.every(name => {
                const matching = releaseArtifacts.filter(artifact => artifact.name === name);
                if (matching.length !== 1) return false;
                const artifact = matching[0];
                const source = artifact.workflow_run;
                return positiveId(artifact.id) && Number.isSafeInteger(artifact.size_in_bytes) && artifact.size_in_bytes > 0 &&
                    artifact.expired === false && source?.id === run.id && source.head_sha === sha &&
                    source.repository_id === run.repository.id && source.head_repository_id === run.repository.id && source.head_branch === 'main';
            })) return String(run.id);
        }
    } catch {
        // 不能证明原 run 完整通过时，保留全部现有构建与验证门槛。
    }
    return '';
}

async function main(env = process.env, fetchImpl = globalThis.fetch) {
    const sourceRunId = await findValidatedRun({ repository: env.GITHUB_REPOSITORY, sha: env.GITHUB_SHA,
        refType: env.GITHUB_REF_TYPE, token: env.GH_TOKEN, fetchImpl });
    fs.appendFileSync(env.GITHUB_OUTPUT, `source_run_id=${sourceRunId}\n`);
}

if (require.main === module) main().catch(() => {
    console.error('无法写入 Tauri CI 复用检查结果。');
    process.exitCode = 1;
});
module.exports = { findValidatedRun, main };
