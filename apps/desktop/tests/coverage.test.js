import test from 'node:test';
import assert from 'node:assert/strict';
import { appendCoverageGaps } from '../renderer/data/coverage.js';

const gap = (start, end, details = {}) => ({
    networkId: 'home', reason: 'offline', scope: 'apps',
    startedAt: `2026-09-30T10:00:${start}Z`,
    endedAt: `2026-09-30T10:00:${end}Z`, spanSeconds: 5, ...details
});

for (const field of ['detail', 'reasonDetail']) {
    test(`${field}: 不同底层失败原因的相邻区间不合并`, () => {
        const gaps = [];
        const incoming = [gap('00', '05', { [field]: 'permission denied' }),
            gap('05', '10', { [field]: 'source unavailable' })];
        appendCoverageGaps(gaps, incoming);
        assert.deepEqual(gaps, incoming);
    });
}

for (const [first, second] of [
    ['detail', 'detail'], ['reasonDetail', 'reasonDetail'],
    ['detail', 'reasonDetail'], ['reasonDetail', 'detail']
]) {
    test(`${first} 到 ${second}: 同原因相邻区间合并且不修改输入`, () => {
        const incoming = [gap('00', '05', { [first]: 'permission denied' }),
            gap('05', '10', { [second]: 'permission denied' })];
        const original = structuredClone(incoming);
        const gaps = [];
        appendCoverageGaps(gaps, incoming);
        assert.deepEqual(gaps, [{ ...incoming[0], endedAt: incoming[1].endedAt, spanSeconds: 10 }]);
        assert.deepEqual(incoming, original);
    });
}

test('detail 优先于历史字段，包括明确的空字符串', () => {
    const gaps = [];
    const incoming = [gap('00', '05', { detail: '', reasonDetail: 'old failure' }),
        gap('05', '10', { reasonDetail: 'old failure' })];
    appendCoverageGaps(gaps, incoming);
    assert.deepEqual(gaps, incoming);
});

test('同原因区间不跨空档合并，未结束区间保持独立', () => {
    const gaps = [];
    const incoming = [gap('00', '05', { detail: 'permission denied' }),
        gap('10', '15', { detail: 'permission denied' }),
        { ...gap('15', '20', { detail: 'permission denied' }), endedAt: '', spanSeconds: 0 }];
    appendCoverageGaps(gaps, incoming);
    assert.deepEqual(gaps, incoming);
});
