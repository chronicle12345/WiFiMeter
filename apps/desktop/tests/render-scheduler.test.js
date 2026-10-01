import test from 'node:test';
import assert from 'node:assert/strict';
import { createRenderScheduler } from '../renderer/data/render-scheduler.js';
test('a burst paints once; hidden updates paint once on return without losing the latest data', () => {
    let hidden = false, paints = 0, latest = 0, displayed = 0, next = 0;
    const frames = new Map();
    const scheduler = createRenderScheduler({ render: () => { paints++; displayed = latest; }, hidden: () => hidden,
        requestFrame: callback => { frames.set(++next, callback); return next; }, cancelFrame: id => frames.delete(id) });
    const flush = () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback()); };
    for(let i=1;i<=1000;i++){ latest=i; scheduler.schedule(); }
    assert.equal(frames.size,1); flush(); assert.equal(paints,1); assert.equal(displayed,1000);
    scheduler.schedule(); hidden=true; scheduler.visibilityChanged(); assert.equal(frames.size,0);
    for(let i=1001;i<=2000;i++){ latest=i; scheduler.schedule(); }
    flush(); assert.equal(paints,1);
    hidden=false; scheduler.visibilityChanged(); assert.equal(frames.size,1); flush();
    assert.equal(paints,2); assert.equal(displayed,2000);
    scheduler.schedule(); scheduler.stop(); flush(); assert.equal(paints,2);
});
