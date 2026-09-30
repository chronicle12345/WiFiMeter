import test from 'node:test';
import assert from 'node:assert/strict';
import { byteUnitFor, formatByteParts } from '../renderer/data/model.js';

const text = (bytes, preference) => {
    const { value, unit } = formatByteParts(bytes, preference);
    return `${value} ${unit}`;
};

test('自动单位区分零与小流量，最多两位小数且去掉尾零', () => {
    for (const [bytes, expected] of [
        [0n, '0 B'], [1n, '1 B'], [999n, '999 B'], [1000n, '1 KB'],
        [1005n, '1.01 KB'], [1200n, '1.2 KB'], [520000n, '520 KB'],
        [24600000n, '24.6 MB'], [1280000000n, '1.28 GB']
    ]) assert.equal(text(bytes), expected);
    assert.equal(text('520000'), '520 KB');
    assert.equal(text(0n, 'GiB'), '0 B');
});

test('十进制与二进制阈值、舍入进位使用同一套单位选择', () => {
    assert.equal(text(999994n), '999.99 KB');
    assert.equal(text(999995n), '1 MB');
    assert.equal(text(1023n, 'GiB'), '1,023 B');
    assert.equal(text(1024n, 'GiB'), '1 KiB');
    assert.equal(text(1048570n, 'GiB'), '1,023.99 KiB');
    assert.equal(text(1048571n, 'GiB'), '1 MiB');
    assert.equal(text(1048576n), '1.05 MB');
    assert.equal(text(1048576n, 'GiB'), '1 MiB');
    for (const [preference, base, units] of [
        ['GB', 1000n, ['KB', 'MB', 'GB', 'TB', 'PB', 'EB']],
        ['GiB', 1024n, ['KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB']]
    ]) {
        units.forEach((unit, index) => {
            const boundary = base ** BigInt(index + 1);
            assert.equal(text(boundary, preference), `1 ${unit}`);
            assert.equal(byteUnitFor(boundary, preference).divisor, boundary);
            assert.equal(text(boundary + 1n, preference), `1 ${unit}`);
            if (index > 0) assert.equal(text(boundary - 1n, preference), `1 ${unit}`);
        });
    }
});

test('大整数在舍入边界仍然保持精确，聚合量不会溢出', () => {
    assert.equal(text(10055000000000000n - 1n), '10.05 PB');
    assert.equal(text(10055000000000000n), '10.06 PB');
    assert.equal(text('18446744073709551615'), '18.45 EB');
    assert.equal(text('18446744073709551615', 'GiB'), '16 EiB');
    assert.equal(text(123456789125000000000000000n), '123,456,789.13 EB');
});
