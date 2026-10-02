import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWarnPercents } from '../renderer/data/quota-thresholds.js';
test('multiple quota thresholds support decimals, sorting and deduplication',()=>{
 assert.deepEqual(parseWarnPercents('90, 50, 75；90 85.5'),[50,75,85.5,90]);
 for(const raw of ['', '0,50','100.1','50,no','Infinity'])assert.throws(()=>parseWarnPercents(raw));
});
