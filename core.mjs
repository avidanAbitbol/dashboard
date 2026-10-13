import {createCipheriv, createDecipheriv, randomBytes} from 'node:crypto';
export function wei(s) {
  if (!/^\d{1,60}(\.\d{1,18})?$/.test(String(s))) throw Error('Invalid CENT threshold');
  const [a,b=''] = String(s).split('.');
  return BigInt(a)*10n**18n+BigInt(b.padEnd(18,'0'));
}
export function cent(n) {
  const s=BigInt(n).toString().padStart(19,'0'), f=s.slice(-18).replace(/0+$/,'');
  return s.slice(0,-18)+(f?'.'+f:'');
}
export function wallets(text) {
  const list=[...new Set(text.trim().split(/[\s,;]+/).map(x=>x.toLowerCase()))];
  if (!list.length || list.some(x=>!/^0x[0-9a-f]{40}$/.test(x))) throw Error('Invalid watchlist');
  return list;
}
export function event(raw, internal, threshold, watched) {
  const hash=(internal?raw.transaction_hash:raw.hash)?.toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(hash||'')) throw Error('Invalid explorer transaction');
  const time=Date.parse(raw.timestamp);
  if (!Number.isFinite(time)) throw Error('Invalid explorer timestamp');
  if (internal ? raw.success!==true : raw.status!=='ok') return null;
  if (internal && !['call','create','create2','selfdestruct','suicide'].includes(raw.type)) return null;
  const amount=BigInt(raw.value||'0');
  const from=(raw.from?.hash||'').toLowerCase(), to=(raw.to?.hash||raw.created_contract?.hash||'').toLowerCase();
  if (amount<=threshold || (!watched.has(from)&&!watched.has(to))) return null;
  return {hash,from,to,value:amount.toString(),time,block:Number(raw.block_number)};
}
export function seal(state,key) {
  const k=Buffer.from(key,'base64'); if(k.length!==32) throw Error('STATE_KEY must encode 32 bytes');
  const iv=randomBytes(12), c=createCipheriv('aes-256-gcm',k,iv);
  const data=Buffer.concat([c.update(JSON.stringify(state)),c.final()]);
  return Buffer.concat([iv,c.getAuthTag(),data]);
}
export function unseal(data,key) {
  const d=createDecipheriv('aes-256-gcm',Buffer.from(key,'base64'),data.subarray(0,12));
  d.setAuthTag(data.subarray(12,28));
  const state=JSON.parse(Buffer.concat([d.update(data.subarray(28)),d.final()]).toString());
  if(state.version!==1 || !state.feeds || !state.pending || !state.sent) throw Error('Invalid state');
  return state;
}
export function initialState(now) {return {version:1,start:now,feeds:{},pending:{},sent:{},rotation:0};}
// Fixed cutoff/target and persisted pagination prevent dropping busy-wallet backlogs.
export async function scanFeed(state,id,load,threshold,watched,now,maxPages=3) {
  const feed=state.feeds[id] ||= {watermark:state.start};
  feed.target ??= now;
  const cutoff=Math.max(state.start,feed.watermark-3600000);
  for(let page=0;page<maxPages;page++) {
    const result=await load(feed.cursor);
    if(!Array.isArray(result.items)) throw Error('Invalid explorer response');
    let oldest=Infinity;
    for(const raw of result.items) {
      // Pending transactions have no block or timestamp yet. Revisit from the
      // head on the next scan; only confirmed transfers can trigger alerts.
      if(raw.block_number==null && raw.timestamp==null) continue;
      const timestamp=Date.parse(raw.timestamp);
      if(!Number.isFinite(timestamp)) throw Error('Invalid explorer timestamp');
      oldest=Math.min(oldest,timestamp);
      if(timestamp<cutoff) continue;
      const e=event(raw,id.endsWith('/internal-transactions'),threshold,watched);
      if(e && !state.sent[e.hash]) {
        const group=state.pending[e.hash] ||= [];
        if(!group.some(x=>x.from===e.from&&x.to===e.to&&x.value===e.value)) group.push(e);
      }
    }
    if(!result.next_page_params || oldest<cutoff) {
      feed.watermark=feed.target; delete feed.target; delete feed.cursor; return true;
    }
    feed.cursor=result.next_page_params;
  }
  return false;
}
export function confirmed(receipt,head,block) {
  return receipt?.status==='0x1' && head-Number(BigInt(receipt.blockNumber))>=12 &&
    block?.hash?.toLowerCase()===receipt.blockHash?.toLowerCase();
}
