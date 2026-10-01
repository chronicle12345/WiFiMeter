import { t, tr } from '../i18n.js';
import { applicationPath } from './history.js';

const errorText = error => typeof error === 'string' ? error : error?.message || '';
export function createAppControlModel(desktop) {
    const model = {
        supported: desktop.platform === 'win32' && Boolean(desktop.appControl),
        path: '', name: '', state: null, warning: '', error: '', busy: false,
        select(app) {
            if (this.busy) return;
            this.path = applicationPath(app); this.name = app.name || this.path;
            this.state = null; this.warning = ''; this.error = '';
        },
        async choose() { return operate(() => desktop.appControl.chooseProgram()); },
        async run(action, uploadKBps) {
            if (!this.path) return;
            if (action === 'throttle' && (!Number.isFinite(uploadKBps) || !Number.isSafeInteger(uploadKBps * 8) || uploadKBps < 0.125 || uploadKBps > 125000000)) {
                this.error = t('上传速率须为 0.125 到 125000000 KB/s，且为 0.125 的整数倍。'); return;
            }
            return operate(() => desktop.appControl.request({ action, path: this.path, ...(action === 'throttle' ? { uploadKBps } : {}) }));
        }
    };
    async function operate(call) {
        if (!model.supported || model.busy) return;
        model.busy = true; model.error = '';
        try {
            const response = await call();
            if (response.result) {
                model.path = response.result.path || model.path;
                model.state = response.result.state ?? null;
                model.warning = response.result.warning || '';
            }
            if (response.canceled) model.error = t('操作已取消。');
            else if (!response.ok) { model.error = errorText(response.error) || t('操作未完成。'); if (!response.result) model.state = null; }
            return response;
        } catch (error) { model.state = null; model.error = errorText(error); }
        finally { model.busy = false; }
    }
    return model;
}

export function legacyMessage(result) {
    if (!result || result.canceled) return '';
    if (result.error) return errorText(result.error);
    if (result.imported || result.alreadyImported) {
        const lines = [result.alreadyImported ? t('此目录已导入，无需重复导入。') : t('旧版数据已导入。')];
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
