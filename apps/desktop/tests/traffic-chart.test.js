import test from 'node:test';
import assert from 'node:assert/strict';
import { trafficChartSvg, boundedCurvePath, sampleTrafficRows } from '../renderer/ui/traffic-chart.js';
import { getLanguage, setLanguage } from '../renderer/i18n.js';

test('traffic curves break at missing samples and retain accessible values and escaping', () => {
    const svg = trafficChartSvg([
        { key: '<first>', label: '<first>', rx: 100n, tx: 20n },
        { key: 'gap', label: 'gap', rx: 0n, tx: 0n, missing: true },
        { key: 'last', label: 'last', rx: 50n, tx: 10n }
    ], { id: 'trend', style: 'line', periodLabel: 'Today' });
    assert.match(svg, /aria-labelledby="trend-title"/);
    assert.match(svg, /aria-describedby="trend-desc"/);
    assert.match(svg, /&lt;first&gt;/);
    assert.doesNotMatch(svg, /<first>/);
    assert.equal((svg.match(/class="traffic-line traffic-rx"/g) || []).length, 2);
    assert.equal((svg.match(/data-chart-point="1"/g) || []).length, 3);
    assert.match(svg, /data-missing="1"/);
    assert.doesNotMatch(svg, /NaN|Infinity/);
});

test('the retained bar chart stacks download and upload and marks rate tooltips', () => {
    const svg = trafficChartSvg([{ key: 'now', label: 'now', rx: 400n, tx: 300n }], { style: 'bar', mode: 'speed', speedUnit: 'Mbps' });
    assert.match(svg, /class="bar-rx"/);
    assert.match(svg, /class="bar-tx"/);
    assert.match(svg, /data-chart-mode="speed"/);
    assert.match(svg, /Mbps/);
});

test('bounded cubic controls cannot exceed neighboring samples or create negative rates', () => {
    assert.equal(boundedCurvePath([{ x: 0, y: 50 }, { x: 30, y: 0 }, { x: 60, y: 50 }]), 'M0 50C10 50 20 0 30 0C40 0 50 50 60 50');
    assert.equal(boundedCurvePath([]), '');
});

test('rate time axes use timestamps and large byte values are scaled before conversion', () => {
    const svg = trafficChartSvg([
        { key: 'a', label: 'a', at: 0, rx: 9007199254740993000000n, tx: 0n },
        { key: 'b', label: 'b', at: 1000, rx: 1n, tx: 0n },
        { key: 'c', label: 'c', at: 4000, rx: 2n, tx: 0n }
    ], { width: 500, height: 180, mode: 'speed', startAt: 0, endAt: 5000 });
    assert.doesNotMatch(svg, /NaN|Infinity/);
    assert.match(svg, /data-rx="9007199254740993000000"/);
    assert.match(svg, /data-chart-mode="speed"/);
});

test('missing rate fields are displayed as unavailable even when the caller omitted the missing flag', () => {
    const svg = trafficChartSvg([{ key: 'unavailable', label: 'unavailable', rx: null, tx: '0' }], { style: 'bar', mode: 'speed' });
    assert.match(svg, /data-missing="1"/);
    assert.doesNotMatch(svg, /class="bar-rx"/);
    assert.doesNotMatch(svg, /class="bar-tx"/);
});

const descriptionCases = [
    ['measured rates', [{ key: 'sample', rx: 400n, tx: 200n }], false],
    ['measured zero', [{ key: 'sample', rx: 0n, tx: 0n }], false],
    ['mixed measured and missing rates', [{ key: 'sample', rx: 400n, tx: 200n }, { key: 'gap', rx: null, tx: null }], false],
    ['only missing rates', [{ key: 'gap', rx: null, tx: null }, { key: 'gap-flag', rx: 400n, tx: 200n, missing: true }], true],
    ['an empty window', [], true]
];
for (const [language, unitLabel, missingLabel, downloadLabel, uploadLabel, periodLabel] of [
    ['zh-CN', '单位', '无记录', '下载', '上传', '最近 5 分钟'],
    ['en', 'Unit', 'No records', 'Download', 'Upload', 'Last 5 minutes']
]) {
    for (const [state, rows, unavailable] of descriptionCases) {
        test(language + ' chart descriptions distinguish ' + state, () => {
            const previous = getLanguage();
            try {
                setLanguage(language);
                for (const style of ['line', 'bar']) {
                    const svg = trafficChartSvg(rows, { id: 'rate', style, mode: 'speed', speedUnit: 'Mbps', periodLabel });
                    const title = /<title[^>]*>(.*?)<\/title>/.exec(svg)[1];
                    const description = /<desc[^>]*>(.*?)<\/desc>/.exec(svg)[1];
                    assert.equal(title, periodLabel + ' ' + downloadLabel + ' / ' + uploadLabel + ' (Mbps)');
                    assert.ok(description.includes(unitLabel + ' Mbps'));
                    assert.ok(description.includes(downloadLabel + ' / ' + uploadLabel));
                    assert.equal(description.includes(missingLabel), unavailable);
                    assert.match(svg, /aria-labelledby="rate-title"/);
                    assert.match(svg, /aria-describedby="rate-desc"/);
                    if (rows.some(row => row.key === 'gap')) assert.ok(svg.includes('aria-label="gap ' + missingLabel + '"'));
                }
            } finally { setLanguage(previous); }
        });
    }
}

test('dense rate charts preserve both directional extrema and a missing break without changing source values', () => {
    const source = Array.from({ length: 1201 }, (_, index) => ({ at: index * 250, key: String(index), label: String(index), rx: 100n, tx: 20n }));
    source[311] = { ...source[311], rx: 999999n };
    source[312] = { ...source[312], tx: 888888n };
    source[313] = { ...source[313], missing: true };
    source[314] = { ...source[314], rx: 0n, tx: 0n };
    const before = structuredClone(source);
    const rows = sampleTrafficRows(source, { width: 500, startAt: 0, endAt: 300000 });
    assert.ok(rows.length <= 500);
    assert.ok(rows.includes(source[311]));
    assert.ok(rows.includes(source[312]));
    assert.ok(rows.includes(source[314]));
    assert.ok(rows.some(row => row.missing));
    for (let index = 1; index < rows.length; index++) {
        if (rows[index - 1].missing || rows[index].missing) continue;
        const first = source.indexOf(rows[index - 1]), last = source.indexOf(rows[index]);
        assert.ok(!source.slice(first + 1, last).some(row => row.missing));
    }
    assert.deepEqual(source, before);
    const svg = trafficChartSvg(source, { width: 550, mode: 'speed', startAt: 0, endAt: 300000 });
    assert.ok((svg.match(/data-chart-point="1"/g) || []).length <= 500);
    assert.match(svg, /data-rx="999999"/);
    assert.match(svg, /data-tx="888888"/);
});

test('dense stacked rate bars retain combined extrema that are not either directional extremum', () => {
    const rows = Array.from({ length: 1201 }, (_, index) => ({ at: index * 250, key: String(index), rx: 100n, tx: 20n }));
    rows[311] = { ...rows[311], rx: 1000n, tx: 0n };
    rows[312] = { ...rows[312], rx: 0n, tx: 1000n };
    rows[313] = { ...rows[313], rx: 700n, tx: 700n };
    rows[314] = { ...rows[314], rx: 50n, tx: 50n };
    const svg = trafficChartSvg(rows, { width: 550, style: 'bar', mode: 'speed', startAt: 0, endAt: 300000 });
    assert.ok(/data-key="313" data-rx="700" data-tx="700"/.test(svg), 'the combined peak must remain inspectable');
    assert.ok(/data-key="314" data-rx="50" data-tx="50"/.test(svg), 'the combined minimum must remain inspectable');
    assert.ok((svg.match(/data-chart-point="1"/g) || []).length <= 500);
});

test('rolling axes label the complete time window instead of overlapping recent sample labels', () => {
    const rows = [299000, 299250, 299500, 299750].map((at, index) => ({ at, key: 'sample-' + index, label: 'sample-' + index, rx: 2000000n, tx: 100000n }));
    const svg = trafficChartSvg(rows, { width: 660, height: 200, mode: 'speed', speedUnit: 'Mbps', startAt: 0, endAt: 300000 });
    assert.doesNotMatch(svg, />sample-\d<[/]text>/);
    assert.match(svg, /text-anchor="start"/);
    assert.match(svg, /text-anchor="end"/);
    assert.match(svg, />20<[/]text>/);
    assert.doesNotMatch(svg, />40<[/]text>/);
});

test('unobserved time before the first rate point has no measured tooltip target', () => {
    const rows = [{ at: 299000, key: 'recent', label: 'recent', rx: 1n, tx: 0n }, { at: 299500, key: 'last', label: 'last', rx: 2n, tx: 0n }];
    const svg = trafficChartSvg(rows, { width: 660, mode: 'speed', startAt: 0, endAt: 300000 });
    const target = /class="bar-hit" x="([\d.]+)"/.exec(svg);
    assert.ok(Number(target[1]) > 640);
});
