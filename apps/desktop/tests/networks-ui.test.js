import test from 'node:test';
import assert from 'node:assert/strict';
import { networkDisplayName, isEthernet } from '../renderer/data/networks.js';
test('有线名称优先备注，其次当前系统名称，离线回退不修改身份',()=>{
 const n={id:'ethernet-key',ssid:'Ethernet:identity',type:'ethernet',alias:''};
 const links=[{networkId:n.id,adapterAlias:'Ethernet 2',type:'ethernet'}];
 assert.equal(networkDisplayName(n,links),'Ethernet 2');
 assert.equal(networkDisplayName({...n,alias:'Office'},links),'Office');
 assert.equal(networkDisplayName(n,[]),'有线网络');
 assert.equal(n.ssid,'Ethernet:identity');assert.equal(isEthernet(n),true);
 assert.equal(networkDisplayName({id:'wifi',ssid:'Ethernet:real-ssid',type:'wifi'},links),'Ethernet:real-ssid');
});
