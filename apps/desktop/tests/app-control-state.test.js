import test from 'node:test';
import assert from 'node:assert/strict';
import { appControlView, appRulesView } from '../renderer/ui/app-control.js';
import { setLanguage } from '../renderer/i18n.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const helpers = { esc, button: (action, label) => `<button data-action="${action}">${label}</button>` };
const base = { Blocked: false, Throttled: false, DownloadThrottled: false };
function views(state) {
    const control = { supported: true, path: 'C:\\Apps\\Partial.exe', name: 'Partial', state,
        rules: [{ path: 'C:\\Apps\\Partial.exe', name: 'Partial', state, savedAt: '2026-10-12T00:00:00.000Z' }] };
    return [appControlView(control, helpers), appRulesView(control, helpers)];
}

for (const [direction, expected] of [['Inbound', '仅阻止入站'], ['Outbound', '仅阻止出站']]) {
    test(`限制详情和列表显示仅 ${direction} 防火墙规则已配置`, () => {
        const state = { ...base, InboundBlocked: direction === 'Inbound', OutboundBlocked: direction === 'Outbound', FirewallRuleCount: 1 };
        for (const html of views(state)) assert.ok(html.includes(expected), html);
    });
}

test('存在已禁用的防火墙规则时不显示为没有配置', () => {
    for (const html of views({ ...base, InboundBlocked: false, OutboundBlocked: false, FirewallRuleCount: 1 })) {
        assert.ok(html.includes('规则未启用'), html);
    }
});

test('防火墙查询错误显示未知状态而不沿用旧的已配置状态', () => {
    for (const html of views({ ...base, Blocked: true, FirewallError: 'query failed', FirewallErrorCode: 'FirewallQueryFailed' })) {
        assert.match(html, /防火墙规则.*?未知/s);
    }
});

test('旧记录和双向规则保留正确的合并状态', () => {
    for (const html of views({ ...base, Blocked: true })) assert.match(html, /防火墙规则.*?已配置/s);
    for (const html of views({ ...base, InboundBlocked: false, OutboundBlocked: false, FirewallRuleCount: 0 })) {
        assert.match(html, /防火墙规则.*?未配置/s);
    }
});

test('英文界面同样区分单向防火墙状态', t => {
    setLanguage('en');
    t.after(() => setLanguage('zh-CN'));
    for (const html of views({ ...base, InboundBlocked: true, OutboundBlocked: false, FirewallRuleCount: 1 })) {
        assert.ok(html.includes('Only inbound blocking configured'), html);
    }
});
