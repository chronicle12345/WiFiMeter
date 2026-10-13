// Compare synthetic history and abandoned avatar queues against the same Git baseline.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '../..');
const revision = process.argv[2] || '0df2e49';
const renderer = 'apps/desktop/renderer/';
const moduleUrl = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
const localUrl = file => pathToFileURL(path.join(root, renderer, file)).href;
const baselineSource = file => execFileSync('git', ['show', `${revision}:${renderer}${file}`], { cwd: root, encoding: 'utf8', windowsHide: true });
const oldProxyUrl = moduleUrl(baselineSource('data/proxy.js').replace("'../i18n.js'", JSON.stringify(localUrl('i18n.js'))));
const beforeDetails = await import(moduleUrl(baselineSource('data/application-proxy.js')
    .replace("'./history.js'", JSON.stringify(localUrl('data/history.js'))).replace("'./proxy.js'", JSON.stringify(oldProxyUrl))));
const afterDetails = await import(localUrl('data/application-proxy.js'));
const beforeIcons = await import(moduleUrl(baselineSource('ui/app-icons.js')));
const afterIcons = await import(localUrl('ui/app-icons.js'));
const median = values => values.sort((left, right) => left - right)[Math.floor(values.length / 2)];

const clientId = 'C:\\Apps\\Selected.exe', proxyId = 'C:\\Proxy\\Selected.exe';
const row = appId => ({ networkId: 'fixture', date: '2026-10-02', appId, name: appId, rxBytes: '100', txBytes: '40' });
const nativeRecords = Array.from({ length: 50000 }, (_, index) => row(`C:\\Proxy\\Other${index}.exe`));
nativeRecords.push(row(proxyId));
const selected = { ...row(clientId), proxyAppId: proxyId, proxyName: 'Selected proxy', estimated: true, rxBytes: '60', txBytes: '20' };
const estimatedRecords = Array.from({ length: 10000 }, (_, index) => ({ ...row(`C:\\Clients\\Other${index}.exe`),
    proxyAppId: nativeRecords[index].appId, estimated: true }));
estimatedRecords.push(selected, { ...selected, appId: 'unattributed', rxBytes: '40', txBytes: '20', unattributed: true });
const range = { start: '2026-10-01', end: '2026-10-31' };

function measureDetails(details, estimates) {
    const options = { nativeRecords, estimatedRecords: estimates, range, networkId: 'fixture' };
    const expected = estimates.length ? [selected] : [];
    assert.deepEqual(details({ id: clientId }, options).estimates, expected);
    const samples = [], iterations = 10;
    for (let run = 0; run < 5; run++) {
        globalThis.gc?.();
        const start = performance.now();
        for (let iteration = 0; iteration < iterations; iteration++) details({ id: clientId }, options);
        samples.push((performance.now() - start) / iterations);
    }
    return { medianMsPerRefresh: +median(samples).toFixed(4) };
}

function measureRevisionDetails(cached) {
    const samples = [], validationCounts = [], iterations = 10;
    for (let run = 0; run < 5; run++) {
        let validations = 0;
        const counted = { ...nativeRecords.at(-1) };
        Object.defineProperty(counted, 'rxBytes', { enumerable: true, get() { validations++; return '100'; } });
        const options = { revision: 1, nativeRecords: [...nativeRecords.slice(0, -1), counted], estimatedRecords, range,
            networkId: 'fixture', proxy: { clients: [] } };
        const resolve = cached ? afterDetails.createApplicationProxyResolver() : afterDetails.applicationProxyDetails;
        assert.deepEqual(resolve({ id: clientId }, options).estimates, [selected]);
        const start = performance.now();
        for (let iteration = 0; iteration < iterations; iteration++) {
            options.proxy.clients = [{ appId: clientId, measurementAvailable: true, rxPerSecond: String(iteration) }];
            const result = resolve({ id: clientId }, options);
            assert.equal(result.clients[0].rxPerSecond, String(iteration));
            assert.deepEqual(result.estimates, [selected]);
        }
        samples.push((performance.now() - start) / iterations); validationCounts.push(validations);
    }
    return { medianMsPerRefresh: +median(samples).toFixed(4), refreshesIncludingWarmup: iterations + 1,
        historyValidations: median(validationCounts) };
}

const png = 'data:image/png;base64,aWNvbg==';
const avatar = appId => ({ dataset: { appIcon: appId }, isConnected: true, image: null,
    querySelector() { return this.image; }, replaceChildren(image) { this.image = image; } });
const frame = () => new Promise(setImmediate);
async function measureIcons(create) {
    const samples = [], counts = [], delayMs = 2;
    for (let run = 0; run < 5; run++) {
        const releases = []; let calls = 0, active = 0, peak = 0;
        const loader = create({ createImage: () => ({ set src(value) { this.url = value; queueMicrotask(() => this.onload?.()); } }),
            request: async () => {
                calls++; active++; peak = Math.max(peak, active);
                if (calls <= 4) await new Promise(resolve => releases.push(resolve));
                else await new Promise(resolve => setTimeout(resolve, delayMs));
                active--; return png;
            } });
        const abandoned = Array.from({ length: 100 }, (_, index) => avatar(`abandoned-${index}`));
        loader.hydrate({ querySelectorAll: () => abandoned });
        await frame();
        abandoned.forEach(node => { node.isConnected = false; });
        const current = avatar('current');
        const start = performance.now();
        loader.hydrate({ querySelectorAll: () => [current] });
        releases.forEach(resolve => resolve());
        while (!current.image) await new Promise(resolve => setTimeout(resolve, 1));
        samples.push(performance.now() - start); counts.push(calls);
        assert.equal(current.image.url, png); assert.ok(peak <= 4);
        loader.stop();
    }
    return { requests: median(counts), medianCurrentAvatarMs: +median(samples).toFixed(2), simulatedRequestDelayMs: delayMs };
}

console.log(JSON.stringify({ baseline: revision,
    fixture: { nativeRows: nativeRecords.length, estimateRows: estimatedRecords.length, abandonedAvatars: 100 },
    emptyEstimates: { before: measureDetails(beforeDetails.applicationProxyDetails, []), after: measureDetails(afterDetails.applicationProxyDetails, []) },
    selectedProxyGroup: { before: measureDetails(beforeDetails.applicationProxyDetails, estimatedRecords), after: measureDetails(afterDetails.applicationProxyDetails, estimatedRecords) },
    stableRevision: { direct: measureRevisionDetails(false), cached: measureRevisionDetails(true) },
    abandonedIcons: { before: await measureIcons(beforeIcons.createAppIconLoader), after: await measureIcons(afterIcons.createAppIconLoader) }
}, null, 2));
