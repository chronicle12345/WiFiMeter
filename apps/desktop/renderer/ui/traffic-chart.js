import { t } from '../i18n.js';
import { byteUnitFor, formatByteParts } from '../data/model.js';
import { formatSpeedParts } from '../data/speed.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const bytes = value => {
    if (typeof value !== 'bigint' && !(typeof value === 'string' && /^\d+$/.test(value)) && !Number.isSafeInteger(value)) return null;
    try { const result = BigInt(value); return result >= 0n ? result : null; } catch { return null; }
};
const coordinate = value => Number(value.toFixed(3));
const scaled = (value, divisor) => Number(value / divisor) + Number(value % divisor) / Number(divisor);

// Each cubic stays within the rectangle formed by its two endpoints.
export function boundedCurvePath(points) {
    if (!points.length) return '';
    let path = `M${coordinate(points[0].x)} ${coordinate(points[0].y)}`;
    for (let index = 1; index < points.length; index++) {
        const previous = points[index - 1], point = points[index], third = (point.x - previous.x) / 3;
        path += `C${coordinate(previous.x + third)} ${coordinate(previous.y)} ${coordinate(point.x - third)} ${coordinate(point.y)} ${coordinate(point.x)} ${coordinate(point.y)}`;
    }
    return path;
}

// Retain directional extrema and stacked totals; omitted gaps still break curves.
export function sampleTrafficRows(rows, { width, startAt, endAt, stacked = false } = {}) {
    const target = Math.max(24, Math.floor(Number.isFinite(width) ? width : 600));
    if (rows.length <= target) return rows;
    const bucketCount = Math.max(1, Math.floor(target / (stacked ? 16 : 12)));
    const timed = Number.isFinite(startAt) && Number.isFinite(endAt) && endAt > startAt && rows.every(row => Number.isFinite(row.at));
    const buckets = Array.from({ length: bucketCount }, () => []);
    rows.forEach((row, index) => {
        const position = timed ? (row.at - startAt) / (endAt - startAt) : index / rows.length;
        const bucket = Math.max(0, Math.min(bucketCount - 1, Math.floor(position * bucketCount)));
        buckets[bucket].push(index);
    });
    const selected = new Set();
    for (const indices of buckets) {
        if (!indices.length) continue;
        selected.add(indices[0]); selected.add(indices.at(-1));
        const measured = indices.filter(index => !rows[index].missing);
        if (!measured.length) continue;
        for (const direction of stacked ? ['rx', 'tx', 'total'] : ['rx', 'tx']) {
            const value = index => direction === 'total' ? rows[index].rx + rows[index].tx : rows[index][direction];
            let minimum = measured[0], maximum = minimum;
            for (const index of measured) {
                if (value(index) < value(minimum)) minimum = index;
                if (value(index) > value(maximum)) maximum = index;
            }
            selected.add(minimum); selected.add(maximum);
        }
    }
    const nextMissing = new Array(rows.length + 1).fill(rows.length);
    for (let index = rows.length - 1; index >= 0; index--) nextMissing[index] = rows[index].missing ? index : nextMissing[index + 1];
    const result = [], indices = [...selected].sort((a, b) => a - b);
    indices.forEach((index, position) => {
        const previous = indices[position - 1];
        if (position && !rows[previous].missing && !rows[index].missing) {
            const gap = nextMissing[previous + 1];
            if (gap < index) result.push(rows[gap]);
        }
        result.push(rows[index]);
    });
    return result;
}

function axisUnit(peak, { mode, speedUnit, byteUnit }) {
    if (mode !== 'speed') return byteUnitFor(peak, byteUnit);
    if (speedUnit === 'MB/s') return { unit: 'MB/s', divisor: 1000000n };
    if (speedUnit === 'Mbps') return { unit: 'Mbps', divisor: 125000n };
    const units = ['B/s', 'KB/s', 'MB/s', 'GB/s', 'TB/s', 'PB/s', 'EB/s'];
    let divisor = 1n, index = 0;
    while (index < units.length - 1 && peak >= divisor * 1000n) { divisor *= 1000n; index++; }
    return { unit: units[index], divisor };
}

export function trafficChartScale(input, { style = 'line', mode = 'usage', byteUnit = 'GB', speedUnit = 'auto' } = {}) {
    const peak = input.reduce((maximum, row) => {
        const rx = bytes(row.rx), tx = bytes(row.tx);
        if (row.missing || rx === null || tx === null) return maximum;
        const value = style === 'bar' ? rx + tx : rx > tx ? rx : tx;
        return value > maximum ? value : maximum;
    }, 0n);
    return { peak, ...axisUnit(peak, { mode, speedUnit, byteUnit }) };
}

export function trafficChartSvg(input, { id = 'usage-chart', width = 660, height = 200, style = 'line', mode = 'usage',
    byteUnit = 'GB', speedUnit = 'auto', periodLabel = '', startAt, endAt } = {}) {
    const sourceRows = input.map(row => {
        const rx = bytes(row.rx), tx = bytes(row.tx);
        return { ...row, rx: rx ?? 0n, tx: tx ?? 0n, missing: Boolean(row.missing || rx === null || tx === null) };
    });
    const w = Math.max(160, Number.isFinite(width) ? width : 660), h = Math.max(100, Number.isFinite(height) ? height : 200);
    const left = 50, right = 10, top = 18, bottom = 30, plotWidth = w - left - right, plotHeight = h - top - bottom;
    const rows = style === 'bar' && mode !== 'speed' ? sourceRows : sampleTrafficRows(sourceRows, { width: plotWidth, startAt, endAt, stacked: style === 'bar' });
    const { peak, unit, divisor } = trafficChartScale(rows, { style, mode, speedUnit, byteUnit });
    const largest = Math.max(scaled(peak, divisor), 1), rawStep = largest / 4;
    const power = 10 ** Math.floor(Math.log10(rawStep)), fraction = rawStep / power;
    const step = [1, 2, 2.5, 5, 10].find(value => value >= fraction) * power, maximum = step * 4;
    const format = value => {
        const result = mode === 'speed' ? formatSpeedParts(value.toString(), speedUnit) : formatByteParts(value, byteUnit);
        return `${result.value} ${result.unit}`;
    };
    const safeId = escape(id), title = `${periodLabel} ${t('下载')} / ${t('上传')} (${unit})`.trim();
    const description = [t('单位') + ' ' + unit, t('下载') + ' / ' + t('上传')];
    if (!sourceRows.some(row => !row.missing)) description.push(t('无记录'));
    let svg = `<svg class="chart traffic-chart traffic-chart-${style === 'bar' ? 'bar' : 'line'}" data-chart-id="${safeId}" data-chart-mode="${mode}" viewBox="0 0 ${w} ${h}" role="img" aria-labelledby="${safeId}-title" aria-describedby="${safeId}-desc"><title id="${safeId}-title">${escape(title)}</title><desc id="${safeId}-desc">${escape(description.join('; '))}</desc><text x="${left}" y="11">${escape(unit)}</text>`;
    for (let tick = 0; tick <= 4; tick++) {
        const y = top + plotHeight * (1 - tick / 4), value = maximum * tick / 4;
        svg += `<line class="gridline" x1="${left}" y1="${coordinate(y)}" x2="${w - right}" y2="${coordinate(y)}"/><text x="${left - 8}" y="${coordinate(y + 3)}" text-anchor="end">${value.toLocaleString('en-US', { maximumFractionDigits: 2 })}</text>`;
    }
    const timed = Number.isFinite(startAt) && Number.isFinite(endAt) && endAt > startAt && rows.every(row => Number.isFinite(row.at));
    const cell = plotWidth / Math.max(rows.length, 1);
    const xOf = (row, index) => timed ? left + plotWidth * Math.max(0, Math.min(1, (row.at - startAt) / (endAt - startAt)))
        : left + cell * (index + 0.5);
    const yOf = value => top + plotHeight * (1 - scaled(value, divisor) / maximum);
    if (timed) {
        const ticks = Math.max(1, Math.floor(plotWidth / 100));
        for (let tick = 0; tick <= ticks; tick++) {
            const at = startAt + (endAt - startAt) * tick / ticks, x = left + plotWidth * tick / ticks;
            const label = new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
            svg += `<text x="${coordinate(x)}" y="${h - 9}" text-anchor="${tick === 0 ? 'start' : tick === ticks ? 'end' : 'middle'}">${escape(label)}</text>`;
        }
    }
    if (style !== 'bar') {
        for (const direction of ['rx', 'tx']) {
            let segment = [];
            const flush = () => {
                if (!segment.length) return;
                svg += `<path class="traffic-line traffic-${direction}" d="${boundedCurvePath(segment)}"/>`;
                if (segment.length === 1) svg += `<circle class="traffic-dot traffic-${direction}" cx="${coordinate(segment[0].x)}" cy="${coordinate(segment[0].y)}" r="2"/>`;
                segment = [];
            };
            rows.forEach((row, index) => { if (row.missing) flush(); else segment.push({ x: xOf(row, index), y: yOf(row[direction]) }); });
            flush();
        }
    }
    const labelStep = Math.max(1, Math.ceil(rows.length / Math.max(2, Math.floor(plotWidth / 82))));
    rows.forEach((row, index) => {
        const x = xOf(row, index), bottomY = top + plotHeight;
        const previousX = index ? xOf(rows[index - 1], index - 1) : left;
        const nextX = index + 1 < rows.length ? xOf(rows[index + 1], index + 1) : w - right;
        const firstHalf = rows.length > 1 ? (nextX - x) / 2 : 4, lastHalf = rows.length > 1 ? (x - previousX) / 2 : 4;
        const hitLeft = index ? (previousX + x) / 2 : timed ? Math.max(left, x - firstHalf) : left;
        const hitRight = index + 1 < rows.length ? (x + nextX) / 2 : timed ? Math.min(w - right, x + lastHalf) : w - right;
        const barWidth = Math.max(1, Math.min(32, (timed ? hitRight - hitLeft : cell) * 0.56));
        const accessible = row.missing ? t('无记录') : `${t('下载')} ${format(row.rx)}, ${t('上传')} ${format(row.tx)}`;
        svg += `<g class="bar-group traffic-point" tabindex="0" data-chart-point="1" data-chart-mode="${mode}" data-key="${escape(row.key)}" data-rx="${row.rx}" data-tx="${row.tx}" data-missing="${row.missing ? '1' : '0'}" aria-label="${escape(row.key)} ${escape(accessible)}">`;
        if (row.missing) svg += `<line class="bar-missing" x1="${coordinate(x - 3)}" y1="${bottomY - 1}" x2="${coordinate(x + 3)}" y2="${bottomY - 1}"/>`;
        else if (style === 'bar') {
            const rxHeight = bottomY - yOf(row.rx), txHeight = bottomY - yOf(row.tx);
            svg += `<rect class="bar-rx" x="${coordinate(x - barWidth / 2)}" y="${coordinate(bottomY - rxHeight)}" width="${coordinate(barWidth)}" height="${coordinate(rxHeight)}" rx="2"/><rect class="bar-tx" x="${coordinate(x - barWidth / 2)}" y="${coordinate(bottomY - rxHeight - txHeight)}" width="${coordinate(barWidth)}" height="${coordinate(txHeight)}" rx="2"/>`;
        } else {
            svg += `<circle class="traffic-marker traffic-rx" cx="${coordinate(x)}" cy="${coordinate(yOf(row.rx))}" r="3"/><circle class="traffic-marker traffic-tx" cx="${coordinate(x)}" cy="${coordinate(yOf(row.tx))}" r="3"/>`;
        }
        svg += `<rect class="bar-hit" x="${coordinate(hitLeft)}" y="${top}" width="${coordinate(Math.max(1, hitRight - hitLeft))}" height="${plotHeight + 5}"/></g>`;
        if (!timed && row.label && (index % labelStep === 0 || index === rows.length - 1 && (rows.length - 1) % labelStep > labelStep / 2)) svg += `<text x="${coordinate(x)}" y="${h - 9}" text-anchor="middle">${escape(row.label)}</text>`;
    });
    return svg + '</svg>';
}
