import { autosaveStatus } from './autosave.js';
import { parseWarnPercents, quotaThresholds } from '../data/quota-thresholds.js';
import { MAX_QUOTA_GB, validQuotaGb, formatByteParts } from '../data/model.js';
import { t, tr } from '../i18n.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const format = (bytes, unit) => { const value = formatByteParts(bytes, unit); return `${value.value} ${value.unit}`; };
const periods = () => ({day:t('每天'),month:t('每自然月'),all:t('累计不重置')});

export function totalQuotaPatch(values) {
    const patch = { capGb:Number(values.get('capGb')), warnPercent:values.has('warnPercents')?parseWarnPercents(values.get('warnPercents'))[0]:Number(values.get('warnPercent')), period:values.get('period'), notify:values.has('notify'), autoDisconnect:values.has('autoDisconnect') };
    if (!validQuotaGb(patch.capGb) || !Number.isFinite(patch.warnPercent) || patch.warnPercent < 1 || patch.warnPercent > 100 || !Object.hasOwn(periods(),patch.period)) throw Error(t('总额度设置无效。'));
    if (values.has('warnPercents')) { patch.warnPercents = parseWarnPercents(values.get('warnPercents')); patch.warnPercent = patch.warnPercents[0]; }
    return patch;
}

export function totalQuotaCard(quota, unit = 'GB') {
    if (!quota) return '';
    const used = BigInt(quota.usedBytes || '0'), cap = BigInt(Math.round(quota.capGb * 1e9));
    const percent = cap > 0n ? Math.min(100,Number(used*100n/cap)) : 0;
    return tr`<section class="panel total-quota-card" aria-label="总 Wi-Fi 额度"><div class="panel-head"><div><h2>总 Wi-Fi 额度</h2></div><span>${esc(periods()[quota.period])}</span></div><div class="total-quota-values"><span>已用 ${format(used,unit)}</span><span>剩余额度 ${cap>0n?format(cap>used?cap-used:0n,unit):t('不限制用量')}</span></div><div class="progress" role="progressbar" aria-label="总额度使用比例" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}"><span style="width:${percent}%"></span></div></section>`;
}

export function totalQuotaForm(quota) {
    if (!quota) return tr`<section class="panel settings-group"><div class="panel-head"><h2>总 Wi-Fi 额度</h2><p>后端尚未提供总额度接口。</p></div></section>`;
    return tr`<section class="panel settings-group"><div class="panel-head"><div><h2>总额度设置</h2></div></div><form id="totalQuotaForm" class="quota-form"><div class="field-row"><div class="field"><label for="totalCap">流量额度 GB</label><input class="input" id="totalCap" name="capGb" type="number" min="0" max="${MAX_QUOTA_GB}" step="any" value="${esc(quota.capGb)}"></div><div class="field"><label for="totalPeriod">额度周期</label><select class="input" id="totalPeriod" name="period">${Object.entries(periods()).map(([value,label])=>`<option value="${value}" ${value===quota.period?'selected':''}>${label}</option>`).join('')}</select></div><div class="field"><label for="totalWarn">提醒阈值（%）</label><input class="input" id="totalWarn" name="warnPercents" type="text" placeholder="50, 75, 90, 100" value="${esc(quotaThresholds(quota).join(', '))}" required></div></div><label class="quota-check"><input name="notify" type="checkbox" ${quota.notify?'checked':''}>启用总额度提醒</label><label class="quota-check"><input name="autoDisconnect" type="checkbox" ${quota.autoDisconnect?'checked':''}>总额度达到上限时断开全部 Wi-Fi</label><div class="form-error" role="alert"></div>${autosaveStatus('totalQuotaSaveStatus')}</form></section>`;
}
