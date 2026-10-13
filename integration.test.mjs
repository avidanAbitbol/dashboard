import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {unseal} from './core.mjs';
const main=fileURLToPath(new URL('./monitor.mjs',import.meta.url));
const mock=`
import {appendFileSync} from 'node:fs';
const hash='0x'+'a'.repeat(64), address='0x'+'1'.repeat(40);
globalThis.fetch=async(url,options={})=>{
 const u=String(url); let data;
 if(u==='https://rpc.incentiv.io') {
   const {method}=JSON.parse(options.body);
   const map={eth_chainId:'0x5e25',eth_blockNumber:'0x70',eth_getTransactionReceipt:{status:process.env.REVERTED==='true'?'0x0':'0x1',blockNumber:'0x64',blockHash:hash},eth_getBlockByNumber:{hash}};
   if(!(method in map)) throw Error('Unexpected RPC'); data={result:map[method]};
 } else if(u.startsWith('https://api.github.com/repos/test/monitor/actions/artifacts')) data={artifacts:[]};
 else if(u.startsWith('https://explorer.incentiv.io/api/v2/addresses/')) data={items:[{hash,transaction_hash:hash,timestamp:new Date(Date.now()+1000).toISOString(),block_number:100,from:{hash:address},to:{hash:'0x'+'2'.repeat(40)},value:'10001000000000000000000',status:'ok',success:true,type:'call'}],next_page_params:null};
 else if(u.startsWith('https://api.telegram.org/')) {appendFileSync('sends.jsonl',options.body+'\\n');data={ok:true};}
 else throw Error('Unexpected network call');
 return new Response(JSON.stringify(data),{status:200,headers:{'Content-Type':'application/json'}});
};`;
async function run(extra={}) {
 const dir=await mkdtemp(join(process.cwd(),'.cent-test-'));
 const key=Buffer.alloc(32,4).toString('base64');
 const result=spawnSync(process.execPath,['--import','data:text/javascript;base64,'+Buffer.from(mock).toString('base64'),main],{
 cwd:dir,encoding:'utf8',timeout:15000,env:{...process.env,INITIALIZE:'true',GITHUB_REPOSITORY:'test/monitor',DEFAULT_BRANCH:'main',GITHUB_TOKEN:'fake',STATE_KEY:key,WATCHED_WALLETS:'0x'+'1'.repeat(40),TELEGRAM_BOT_TOKEN:'fake',TELEGRAM_CHAT_ID:'1234',CENT_THRESHOLD:'10000',...extra}});
 return {dir,key,result};
}
test('full mocked run initializes, groups two feeds, sends and encrypts checkpoint',async()=>{
 const {dir,key,result}=await run();
 try {
  assert.equal(result.status,0,result.stderr);
  const messages=(await readFile(join(dir,'sends.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(messages.length,2); assert.match(messages[1].text,/10001 CENT/);
  const state=unseal(await readFile(join(dir,'state.enc')),key);
  assert.equal(Object.keys(state.sent).length,1); assert.equal(Object.keys(state.pending).length,0);
 } finally {await rm(dir,{recursive:true,force:true});}
});
test('outer receipt failure prevents a seemingly successful internal alert',async()=>{
 const {dir,result}=await run({REVERTED:'true'});
 try {assert.equal(result.status,0,result.stderr);assert.equal((await readFile(join(dir,'sends.jsonl'),'utf8')).trim().split('\n').length,1);}
 finally {await rm(dir,{recursive:true,force:true});}
});
test('absent durable state without explicit initialization stops without sending',async()=>{
 const {dir,result}=await run({INITIALIZE:'false'});
 try {assert.equal(result.status,1);await assert.rejects(readFile(join(dir,'sends.jsonl')));await assert.rejects(readFile(join(dir,'state.enc')));}
 finally {await rm(dir,{recursive:true,force:true});}
});
