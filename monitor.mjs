import {readFile,writeFile,rename} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {wei,cent,wallets,seal,unseal,initialState,scanFeed,confirmed} from './core.mjs';

const env=process.env, explorer='https://explorer.incentiv.io', rpcUrl='https://rpc.incentiv.io';
let stage='configuration';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
// Never log fetch errors: Telegram request URLs contain credentials.
async function json(url,options={},attempts=3) {
  for(let attempt=0;attempt<attempts;attempt++) {
    try {
      const r=await fetch(url,{...options,signal:AbortSignal.timeout(15000)});
      if(!r.ok) throw Error('HTTP request failed');
      return await r.json();
    } catch {if(attempt===attempts-1) throw Error('Remote request failed'); await sleep(500*2**attempt);}
  }
}
async function rpc(method,params=[]) {
  const data=await json(rpcUrl,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
  if(data.error||!('result' in data)) throw Error('RPC request failed');
  return data.result;
}
async function telegram(text) {
  // No automatic retry on an ambiguous send: the next run retries unsaved messages.
  const result=await json(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({chat_id:env.TELEGRAM_CHAT_ID,text,link_preview_options:{is_disabled:true}})
  },1);
  if(result.ok!==true) throw Error('Telegram send failed');
}
async function restore() {
  const repo=env.GITHUB_REPOSITORY;
  if(!/^[\w.-]+\/[\w.-]+$/.test(repo||'')) throw Error('Invalid repository');
  const headers={Authorization:`Bearer ${env.GITHUB_TOKEN}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'};
  const list=await json(`https://api.github.com/repos/${repo}/actions/artifacts?name=cent-state&per_page=100`,{headers});
  if(!Array.isArray(list.artifacts)) throw Error('Cannot list saved state');
  const artifact=list.artifacts.filter(a=>!a.expired && a.workflow_run?.head_branch===env.DEFAULT_BRANCH)
    .sort((a,b)=>b.id-a.id)[0];
  if(!artifact) {
    if(env.INITIALIZE!=='true') throw Error('No state: manual initialization required');
    return initialState(Date.now());
  }
  const response=await fetch(`https://api.github.com/repos/${repo}/actions/artifacts/${artifact.id}/zip`,{headers,redirect:'manual',signal:AbortSignal.timeout(20000)});
  if(response.status!==302) throw Error('Cannot download saved state');
  const url=new URL(response.headers.get('location'));
  if(url.protocol!=='https:') throw Error('Invalid state download');
  // Signed blob URL: do not forward GitHub authorization to another host.
  const archive=await fetch(url,{signal:AbortSignal.timeout(20000)});
  if(!archive.ok) throw Error('Cannot download saved state');
  await writeFile('state.zip',Buffer.from(await archive.arrayBuffer()));
  execFileSync('python3',['-c',
    "import zipfile; z=zipfile.ZipFile('state.zip'); i=z.getinfo('state.enc'); assert i.file_size < 2097152; open('state.enc','wb').write(z.read(i))"],{stdio:'pipe'});
  return unseal(await readFile('state.enc'),env.STATE_KEY);
}
async function save(state) {
  const encrypted=seal(state,env.STATE_KEY);
  if(encrypted.length>1500000) throw Error('State capacity reached; maintenance required');
  await writeFile('state.enc.tmp',encrypted,{mode:0o600}); await rename('state.enc.tmp','state.enc');
}
async function main() {
  for(const key of ['WATCHED_WALLETS','TELEGRAM_BOT_TOKEN','TELEGRAM_CHAT_ID','STATE_KEY','GITHUB_TOKEN'])
    if(!env[key]) throw Error(`Missing ${key}`);
  if(!/^\d+$/.test(env.TELEGRAM_CHAT_ID)) throw Error('Use a private Telegram chat');
  const threshold=wei(env.CENT_THRESHOLD||'10000'), watched=new Set(wallets(env.WATCHED_WALLETS));
  stage='network verification';
  if(Number(BigInt(await rpc('eth_chainId')))!==24101) throw Error('Wrong blockchain');
  stage='restore encrypted state';
  const state=await restore();
  stage='read latest block';
  const head=Number(BigInt(await rpc('eth_blockNumber'))), now=Date.now(), deadline=now+210000;
  let errors=0, sent=0, checked=0;
  try {
    if(!state.welcomeSent) {
      stage='send initialization message';
      await telegram(`ניטור CENT הופעל.\n${watched.size} ארנקים · סף מעל ${cent(threshold)} CENT להעברה.\nסריקה מתוכננת כל 5 דקות, ייתכנו עיכובים. המעקב מתחיל עכשיו, ללא היסטוריה.`);
      state.welcomeSent=true; stage='save initialization'; await save(state);
    }
    const feeds=[...watched].flatMap(a=>[`${a}/transactions`,`${a}/internal-transactions`]);
    stage='scan and deliver alerts';
    const rotated=feeds.slice(state.rotation).concat(feeds.slice(0,state.rotation));
    // Two workers limit pressure on the public explorer. Rotate to avoid starvation.
    let next=0;
    await Promise.all([0,1].map(async()=>{
      while(next<rotated.length && Date.now()<deadline) {
        const id=rotated[next++];
        try {
          await scanFeed(state,id,async cursor=>{
            const suffix=cursor?'?'+new URLSearchParams(cursor):'';
            return json(`${explorer}/api/v2/addresses/${id}${suffix}`);
          },threshold,watched,now);
        } catch {errors++;}
        checked++;
      }
    }));
    state.rotation=(state.rotation+next)%feeds.length;
    // Persist the outbox before sending; an interrupted run can continue next time.
    await save(state);
    for(const [hash,all] of Object.entries(state.pending)) {
      if(sent>=20 || Date.now()>deadline+45000) break;
      const events=all.filter(e=>BigInt(e.value)>threshold && (watched.has(e.from)||watched.has(e.to)));
      if(!events.length || state.sent[hash]) {delete state.pending[hash];continue;}
      try {
        const receipt=await rpc('eth_getTransactionReceipt',[hash]);
        if(receipt?.status==='0x0') {delete state.pending[hash];continue;}
        if(!receipt || head-Number(BigInt(receipt.blockNumber))<12) continue;
        const block=await rpc('eth_getBlockByNumber',[receipt.blockNumber,false]);
        if(!confirmed(receipt,head,block)) continue;
        const lines=events.slice(0,4).map(e=>`${cent(e.value)} CENT\nמאת: ${e.from}\nאל: ${e.to}`);
        await telegram(`העברת CENT מעל הסף\n\n${lines.join('\n\n')}\n\n${events.length>4?'העברות נוספות באותה עסקה מופיעות בסייר.\n':''}${explorer}/tx/${hash}`);
        state.sent[hash]=Math.max(...events.map(e=>e.time)); delete state.pending[hash];
        sent++; await save(state); await sleep(1100);
      } catch {errors++; break;}
    }
    // Only prune dedup history once ALL current streams have advanced past it.
    const safeBefore=Math.min(...feeds.map(id=>state.feeds[id]?.watermark??state.start))-3600000;
    for(const [hash,time] of Object.entries(state.sent)) if(time<safeBefore) delete state.sent[hash];
    const active=new Set(feeds); for(const id of Object.keys(state.feeds)) if(!active.has(id)) delete state.feeds[id];
    state.lastRun=now;
    console.log(`Feeds checked: ${checked}/${feeds.length}; alerts sent: ${sent}; request failures: ${errors}; pending transactions: ${Object.keys(state.pending).length}`);
    if(errors) process.exitCode=1;
  } finally {await save(state);}
}
main().catch(error=>{const code=['EPERM','EACCES','ENOENT'].includes(error.code)?` (${error.code})`:'';console.error(`Monitor stopped during: ${stage}${code}. Check required secrets, saved state, and upstream availability. No sensitive error details are logged.`);process.exitCode=1;});
