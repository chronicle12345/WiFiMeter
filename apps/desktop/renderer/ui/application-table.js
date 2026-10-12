import { t, tr } from '../i18n.js';
import { applicationAvatar } from './applications.js';

function sourceBadge(row, live, esc) {
    const measured = row.measurementAvailable !== false && row.rxPerSecond != null && row.txPerSecond != null;
    const label = live ? measured ? t('实测') : t('不可测') : row.unattributed ? t('估算 · 未归属') : row.estimated ? t('估算') : t('原生记录');
    const state = live ? measured ? 'measured' : 'unavailable' : row.estimated || row.unattributed ? 'estimated' : '';
    return `<span class="application-source-badge${state ? ` ${state}` : ''}">${esc(label)}</span>`;
}

// Speed and usage share a row layout while preserving their distinct units and provenance.
export function applicationTable(rows, options = {}, { esc, formatValue, networkLabel }) {
    const { mode = 'usage', grouping = 'summary', sort = 'total', direction = 'desc', selectedKey = '', startIndex = 0, sum = 0n } = options;
    const live = mode === 'live', ranked = live || grouping === 'summary', sortable = !ranked;
    const firstLabel = ranked ? t('排名') : grouping === 'month' ? t('月份') : ['minute', 'hour'].includes(grouping) ? t('时间') : t('日期');
    const columns = [['date', firstLabel], ['name', t('应用')], ['rx', live ? t('下载速度') : t('下载')], ['tx', live ? t('上传速度') : t('上传')], ['total', live ? t('总速度') : t('总用量')]];
    const headings = columns.map(([key, label], index) => {
        const attributes = `${index > 1 ? ' class="right"' : ''}${sortable ? ` aria-sort="${sort === key ? direction === 'asc' ? 'ascending' : 'descending' : 'none'}"` : ''}`;
        return `<th${attributes}>${sortable ? `<button class="link-btn" data-action="app-history-sort" data-key="${key}">${esc(label)}</button>` : esc(label)}</th>`;
    }).join('');
    const body = rows.map((row, index) => {
        const key = row.key || '', id = row.appId || row.id || '', name = row.name || id, selected = key === selectedKey;
        const action = live ? 'select-live-app' : ranked ? 'select-app' : 'select-app-row';
        const identity = live ? `data-live-key="${esc(key)}" data-network-id="${esc(row.networkId || '')}"` : `data-key="${esc(key)}"`;
        const appButton = `<button class="network-name application-name" data-action="${action}" data-app-id="${esc(id)}" ${identity} aria-pressed="${selected}">${applicationAvatar({ ...row, name }, esc, true)}<span class="application-name-text">${esc(name)}</span></button>`;
        const network = row.scope === 'loopback' ? t('本地 TCP') : networkLabel(row.networkId) || row.networkId || '—';
        const pids = row.processIds?.join(', ') || row.processId || '—';
        const meta = live ? `<span>${esc(network)}</span><span>PID ${esc(pids)}</span>${row.scope === 'loopback' ? '' : `<span>${t('网络采集')}</span>`}` : '';
        let share = !live && ranked ? '<span class="application-share-label">—</span>' : '';
        if (!live && ranked && BigInt(sum) > 0n) {
            const ratio = BigInt(row.total ?? 0) * 1000n / BigInt(sum), percentage = (Number(ratio > 1000n ? 1000n : ratio) / 10).toFixed(1);
            share = `<div class="application-row-share" aria-hidden="true"><span style="width:${percentage}%"></span></div><span class="application-share-label">${percentage}%</span>`;
        }
        const metrics = ['rx', 'tx', 'total'].map(field => {
            const value = live ? row.measurementAvailable === false ? null : row[`${field}PerSecond`] : row[field];
            return `<td class="right application-metric">${esc(formatValue(value, mode))}</td>`;
        }).join('');
        return `<tr class="application-table-row${selected ? ' selected-row' : ''}" data-app-row="${esc(key)}"><td${ranked ? ' class="application-row-rank"' : ''}>${ranked ? startIndex + index + 1 : esc(row.date)}</td><td>${appButton}<div class="application-row-meta">${meta}${sourceBadge(row, live, esc)}</div>${share}</td>${metrics}</tr>`;
    }).join('');
    return tr`<div class="table-scroll application-table-scroll"><table class="application-table" data-grouping="${live ? 'live' : grouping}" aria-label="${esc(live ? t('实时流量排行') : t('应用用量记录'))}"><thead><tr>${headings}</tr></thead><tbody>${body}</tbody></table></div>`;
}
