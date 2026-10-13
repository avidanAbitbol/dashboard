import {test} from 'node:test';
import assert from 'node:assert/strict';
import {alertText} from './alerts.mjs';
const from='0x'+'1'.repeat(40),to='0x'+'2'.repeat(40),hash='0x'+'a'.repeat(64);
const events=[{from,to,value:'12500000000000000000001',time:Date.parse('2026-10-13T12:00:00Z')}];
test('alert preserves precise amount and addresses alongside sanitized explorer names',async()=>{
  const text=await alertText(hash,events,new Set([from]),async a=>a===from?'Treasury\n\u202eAccount':'Receiver');
  assert.ok(text.includes('12,500.000000000000000001 CENT'));
  assert.ok(text.includes(from)&&text.includes(to));
  assert.ok(text.includes('Treasury  Account (שם בסייר)'));
  assert.ok(text.includes('15:00:00'));
  assert.ok(text.includes('יציאה מארנק במעקב'));
  assert.ok(text.includes('/tx/'+hash));
});
test('name service failure still produces the full transfer alert',async()=>{
  const text=await alertText(hash,events,new Set([to]),async()=>{throw Error('offline')});
  assert.ok(text.includes('ללא שם בסייר'));
  assert.ok(text.includes('כניסה לארנק במעקב'));
  assert.ok(text.includes(from)&&text.includes(to));
});
