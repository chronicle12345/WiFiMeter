import { t, tr } from '../i18n.js';
import { applicationPath } from './history.js';

const errorText = error => typeof error === 'string' ? error : error?.message || '';
export function createAppControlModel(desktop) {
    let rulesRequest = null;
    const model = {
        supported: desktop.platform === 'win32' && Boolean(desktop.appControl),
        path: '', name: '', state: null, warning: '', error: '', busy: false,
        rules: [], rulesError: '', rulesBusy: false,
        select(app) {
            if (this.busy) return;
            this.path = applicationPath(app); this.name = app.name || this.path;
            this.state = null; this.warning = ''; this.error = '';
        },
        async choose() { return operate(() => desktop.appControl.chooseProgram()); },
        loadRules() {
            if (!this.supported || typeof desktop.appControl.list !== 'function') return Promise.resolve();
            if (rulesRequest) return rulesRequest;
            this.rulesBusy = true; this.rulesError = '';
            rulesRequest = Promise.resolve().then(() => desktop.appControl.list()).then(response => {
                if (response?.ok && Array.isArray(response.records)) this.rules = response.records;
                else this.rulesError = errorText(response?.error) || t('应用限制记录未能读取。');
                return response;
            }).catch(error => { this.rulesError = errorText(error); })
                .finally(() => { this.rulesBusy = false; rulesRequest = null; });
            return rulesRequest;
        },
        async run(action, options) {
            if (!this.path) return;
            const values = typeof options === 'number' ? { uploadKBps: options } : options || {};
            if (action === 'throttle') {
                const rates = ['uploadKBps', 'downloadKBps'].filter(key => Object.hasOwn(values, key));
                if (!rates.length || rates.some(key => !Number.isFinite(values[key]) || !Number.isSafeInteger(values[key] * 8) || values[key] < 0.125 || values[key] > 125000000)) {
                    this.error = t('限速须为 0.125 到 125000000 KB/s，且为 0.125 的整数倍。'); return;
                }
            }
            const parameters = action === 'throttle' ? Object.fromEntries(['uploadKBps', 'downloadKBps'].filter(key => Object.hasOwn(values, key)).map(key => [key, values[key]]))
                : action === 'unthrottle' && values.direction ? { direction: values.direction } : {};
            return operate(() => desktop.appControl.request({ action, path: this.path, ...parameters }));
        }
    };
    async function operate(call) {
        if (!model.supported || model.busy) return;
        model.busy = true; model.error = '';
        try {
            const response = await call();
            if (response.result) {
                if (response.result.path && (response.result.path.toLowerCase() !== model.path.toLowerCase() || !model.name)) {
                    model.name = response.result.path.split(/[\\/]/).pop();
                }
                model.path = response.result.path || model.path;
                model.state = response.result.state ?? null;
                model.warning = response.result.warning || '';
            }
            if (response.canceled) model.error = t('操作已取消。');
            else if (!response.ok) { model.error = errorText(response.error) || t('操作未完成。'); if (!response.result) model.state = null; }
            // 等待先前读取结束后再获取操作后的记录，避免旧列表覆盖刚配置的限制。
            if (rulesRequest) await rulesRequest;
            await model.loadRules();
            if (response.recordsError) model.rulesError = [errorText(response.recordsError), model.rulesError].filter(Boolean).join('\n');
            return response;
        } catch (error) { model.state = null; model.error = errorText(error); }
        finally { model.busy = false; }
    }
    return model;
}

export function legacyMessage(result) {
    if (!result || result.canceled) return '';
    if (result.error) return errorText(result.error);
    if (result.importWarning) return t('当前统计已继续，旧版数据尚未导入。') + '\n' + errorText(result.importWarning);
    if (result.imported || result.alreadyImported) {
        const skipped = result.report?.skippedDayCount || 0;
        const lines = [result.alreadyImported ? t('此目录已导入，无需重复导入。') : skipped ? t('旧版数据导入完成，重叠日期保留现有记录。') : t('旧版数据已导入。')];
        if (skipped) lines.push(tr`已略过 ${skipped} 个重叠日期。`);
        if (result.backupDirectory) lines.push(tr`备份目录：${result.backupDirectory}`);
        const report = result.report;
        if (report?.appArchivedOnlyCount > 0)
            lines.push(tr`仅归档的应用缓存：${report.appArchivedOnlyCount} 条，未加入应用用量统计。`);
        if (Array.isArray(report?.warnings) && report.warnings.length) {
            lines.push(t('导入注意事项：'));
            // 报告文本可能包含原始 SSID 或路径，保留原文；显示层统一转义 HTML。
            lines.push(...report.warnings.map(warning => String(warning)));
        }
        return lines.join('\n');
    }
    return result.found ? t('发现旧版数据，可选择目录导入。') : t('未自动发现旧版数据，可手动选择目录。');
}
