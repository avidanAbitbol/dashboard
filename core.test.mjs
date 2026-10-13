import {test} from 'node:test';
import assert from 'node:assert/strict';
import {wei,cent,wallets,event,seal,unseal,initialState,scanFeed,confirmed} from './core.mjs';
const a='0x'+'1'.repeat(40), b='0x'+'2'.repeat(40), hash='0x'+'a'.repeat(64), watched=new Set([a,b]);
const now=Date.parse('2026-10-13T12:00:00Z');
const raw=(extra={})=>({hash,transaction_hash:hash,from:{hash:a},to:{hash:b},value:wei('10001').toString(),status:'ok',success:true,type:'call',block_number:100,timestamp:new Date(now).toISOString(),...extra});
test('strict threshold distinguishes one wei and rejects imprecise input',()=>{
  assert.equal(wei('10000.000000000000000001'),wei('10000')+1n);
  assert.equal(cent(wei('10000.000000000000000001')),'10000.000000000000000001');
  assert.equal(event(raw({value:wei('10000').toString()}),false,wei('10000'),watched),null);
  assert.ok(event(raw({value:(wei('10000')+1n).toString()}),false,wei('10000'),watched));
  for(const s of ['-1','1e4','1.0000000000000000001','']) assert.throws(()=>wei(s));
});
test('gas does not create an alert; contextual and failed calls are excluded',()=>{
  assert.equal(event(raw({value:'0',fee:{value:wei('999999').toString()}}),false,wei('10000'),watched),null);
  for(const type of ['delegatecall','staticcall','callcode']) assert.equal(event(raw({type}),true,0n,watched),null);
  assert.equal(event(raw({success:false}),true,0n,watched),null);
  assert.equal(event(raw({status:'error'}),false,0n,watched),null);
});
test('watchlist validated and deduplicated',()=>{
  assert.deepEqual(wallets(`${a}\n${a}\n${b}`),[a,b]);
  assert.throws(()=>wallets('')); assert.throws(()=>wallets('bad-address'));
});
test('encrypted state authenticates content and key; random IV changes ciphertext',()=>{
  const state=initialState(now), key=Buffer.alloc(32,7).toString('base64');
  const data=seal(state,key); assert.deepEqual(unseal(data,key),state);
  assert.notDeepEqual(data,seal(state,key));
  assert.throws(()=>unseal(data,Buffer.alloc(32,8).toString('base64')));
  data[data.length-1]^=1; assert.throws(()=>unseal(data,key));
});
test('pagination resumes after page budget and does not advance watermark prematurely',async()=>{
  const state=initialState(now-10000), id=a+'/transactions';
  const load=async cursor=>cursor?{items:[raw({hash:'0x'+'b'.repeat(64)})],next_page_params:null}:{items:[raw()],next_page_params:{block_number:99,index:1}};
  assert.equal(await scanFeed(state,id,load,0n,watched,now,1),false);
  assert.equal(state.feeds[id].watermark,now-10000);
  assert.deepEqual(state.feeds[id].cursor,{block_number:99,index:1});
  assert.equal(await scanFeed(state,id,load,0n,watched,now+1000,1),true);
  assert.equal(state.feeds[id].watermark,now);
  assert.equal(Object.keys(state.pending).length,2);
});
test('failed page preserves checkpoint and can resume without duplicate pending events',async()=>{
  const state=initialState(now-10000), id=a+'/transactions';
  await assert.rejects(scanFeed(state,id,async cursor=>{
    if(cursor) throw Error('outage'); return {items:[raw()],next_page_params:{index:2}};
  },0n,watched,now));
  assert.equal(state.feeds[id].cursor.index,2);
  await scanFeed(state,id,async()=>({items:[raw()],next_page_params:null}),0n,watched,now);
  assert.equal(state.pending[hash].length,1);
});
test('watching both ends and internal root creates one transaction notification',async()=>{
  const state=initialState(now-10000), load=async()=>({items:[raw()],next_page_params:null});
  for(const id of [a+'/transactions',b+'/transactions',a+'/internal-transactions']) await scanFeed(state,id,load,0n,watched,now);
  assert.equal(Object.keys(state.pending).length,1); assert.equal(state.pending[hash].length,1);
  state.sent[hash]=now; delete state.pending[hash];
  await scanFeed(state,a+'/transactions',load,0n,watched,now+1000);
  assert.equal(Object.keys(state.pending).length,0);
});
test('initial start excludes history',async()=>{
  const state=initialState(now+1);
  await scanFeed(state,a+'/transactions',async()=>({items:[raw()],next_page_params:null}),0n,watched,now+10);
  assert.equal(Object.keys(state.pending).length,0);
});
test('receipt must succeed, have twelve subsequent blocks, and match canonical block',()=>{
  const receipt={status:'0x1',blockNumber:'0x64',blockHash:hash},block={hash};
  assert.equal(confirmed(receipt,112,block),true);
  assert.equal(confirmed({...receipt,status:'0x0'},112,block),false);
  assert.equal(confirmed(receipt,111,block),false);
  assert.equal(confirmed(receipt,112,{hash:'other'}),false);
});
