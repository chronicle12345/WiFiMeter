import test from 'node:test';
import assert from 'node:assert/strict';
import { formatSpeedParts } from '../renderer/data/speed.js';
test('automatic speed units switch at decimal boundaries without converting missing data to zero',()=>{
 for(const [bytes,value,unit] of [[0,'0','B/s'],[999,'999','B/s'],[1000,'1.0','KB/s'],[999999,'1000.0','KB/s'],[1000000,'1.0','MB/s'],[1000000000,'1.0','GB/s']])assert.deepEqual(formatSpeedParts(String(bytes)),{value,unit});
 for(const value of [null,undefined,'',-1,'NaN'])assert.equal(formatSpeedParts(value).value,'—');
 assert.deepEqual(formatSpeedParts('125000','Mbps'),{value:'1.00',unit:'Mbps'});
 assert.deepEqual(formatSpeedParts('1000000','MB/s'),{value:'1.00',unit:'MB/s'});
});
