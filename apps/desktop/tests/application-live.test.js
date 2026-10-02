import test from 'node:test';
import assert from 'node:assert/strict';
import { applicationLiveRows, measuredRate } from '../renderer/data/application-live.js';

test('live application grouping separates loopback from Wi-Fi and groups process sockets',()=>{
 const base={appId:'client',name:'Client',scope:'loopback',networkId:'',rxPerSecond:'3000',txPerSecond:'500',measurementAvailable:true};
 const rows=applicationLiveRows([{...base,processId:1},{...base,processId:2},{...base,scope:'wifi',networkId:'home',processId:1}]);
 assert.equal(rows.length,2);assert.equal(rows[0].rxPerSecond,'6000');assert.deepEqual(rows[0].processIds,[1,2]);
 assert.equal(applicationLiveRows(rows,{networkId:'home'}).length,1);
 assert.equal(applicationLiveRows(rows,{search:'missing'}).length,0);
});
test('warming connections remain missing rather than zero and formatting retains units',()=>{
 const rows=applicationLiveRows([{appId:'client',networkId:'',scope:'loopback',rxPerSecond:null,txPerSecond:null,measurementAvailable:false}]);
 assert.equal(rows[0].rxPerSecond,null);assert.equal(measuredRate(rows[0].rxPerSecond,'auto'),'—');
 assert.equal(measuredRate('6000','auto'),'6.0 KB/s');
});
