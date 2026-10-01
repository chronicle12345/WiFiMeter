import test from 'node:test';
import assert from 'node:assert/strict';
import { updateRegion } from '../renderer/data/render.js';

test('相同内容不会再次替换 DOM；正在选择表格文字时推迟后台替换', () => {
    let writes=0, html='';
    const region={ get innerHTML(){return html;}, set innerHTML(value){html=value;writes++;}, contains: node=>node==='selected' };
    assert.equal(updateRegion(region,'<table>one</table>'),true);
    assert.equal(updateRegion(region,'<table>one</table>'),false);
    assert.equal(writes,1);
    assert.equal(updateRegion(region,'<table>two</table>',{selection:{isCollapsed:false,anchorNode:'selected'}}),false);
    assert.equal(writes,1);
    assert.equal(updateRegion(region,'<table>two</table>'),true);
    assert.equal(writes,2);
});

test('主动取消表单编辑时，即使原始 HTML 相同也恢复已保存值', () => {
    let writes=0;
    const region={set innerHTML(value){writes++;}};
    updateRegion(region,'saved form');
    updateRegion(region,'saved form',{force:true});
    assert.equal(writes,2);
});
