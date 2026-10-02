import test from 'node:test';
import assert from 'node:assert/strict';
import { t, tr, setLanguage, getLocale } from '../renderer/i18n.js';
import { totalQuotaForm, totalQuotaCard, totalQuotaPatch } from '../renderer/ui/total-quota.js';

test('语言切换覆盖静态文案与模板，插入的应用名称和路径保持原文',()=>{
    setLanguage('en');
    assert.equal(t('全部历史'),'All history');
    assert.equal(getLocale(),'en-US');
    assert.equal(tr`<h3>完整路径</h3>${'C:\\网络\\设置.exe'}`,'<h3>Full path</h3>C:\\网络\\设置.exe');
    assert.equal(t('下载字节'),'Download bytes');
    setLanguage('zh-CN');
    assert.equal(t('全部历史'),'全部历史');
});

test('总额度表单独立保存字段，概览按独立账本显示且无重复说明',()=>{
    const quota={capGb:2,warnPercent:80,period:'all',notify:true,autoDisconnect:false,usedBytes:'1500000000',periodKey:'all'};
    assert.match(totalQuotaCard(quota,'GB'),/1.5 GB/);
    assert.doesNotMatch(totalQuotaCard(quota,'GB'),/只累计|不包含有线/);
    assert.match(totalQuotaForm(quota),/id="totalQuotaForm"/);
    const values=new Map(Object.entries({capGb:'2',warnPercent:'80',period:'all',notify:'on'}));
    assert.deepEqual(totalQuotaPatch(values),{capGb:2,warnPercent:80,period:'all',notify:true,autoDisconnect:false});
    assert.throws(()=>totalQuotaPatch(new Map([['capGb','-1'],['warnPercent','80'],['period','day']])));
    assert.equal(totalQuotaCard(null,'GB'),'');
});

test('总额度接受主分支上限与一字节，拒绝非零亚字节和越界值',()=>{
    const values=capGb=>new Map([['capGb',String(capGb)],['warnPercent','80'],['period','all']]);
    for(const capGb of [0,1e-9,100000.01,9000000000])assert.equal(totalQuotaPatch(values(capGb)).capGb,capGb);
    for(const capGb of [-1,1e-10,9000000001,Infinity,NaN])assert.throws(()=>totalQuotaPatch(values(capGb)));
    const html=totalQuotaForm({capGb:9000000000,warnPercent:80,period:'all'});
    assert.match(html,/max="9000000000"/);
    assert.match(html,/value="9000000000"/);
    assert.match(html,/step="any"/);
});

test('总额度提醒阈值保留小数并拒绝非有限或越界值',()=>{
    const values=warnPercent=>new Map([['capGb','1'],['warnPercent',String(warnPercent)],['period','month']]);
    for(const threshold of [1,85,85.5,100])assert.equal(totalQuotaPatch(values(threshold)).warnPercent,threshold);
    for(const threshold of [0,100.1,101,NaN,Infinity])assert.throws(()=>totalQuotaPatch(values(threshold)));
    const html=totalQuotaForm({capGb:1,warnPercent:85,period:'month'});
    assert.match(html,/<input[^>]*id="totalWarn"[^>]*name="warnPercents"/);
    assert.match(html,/<input[^>]*id="totalCap"[^>]*step="any"/);
});
