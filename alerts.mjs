import {cent} from './core.mjs';

export function addressName(value) {
  return typeof value==='string' ? value.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g,' ').trim().slice(0,80) : '';
}
export async function alertText(hash,events,watched,lookup) {
  const shown=events.slice(0,4);
  const addresses=[...new Set(shown.flatMap(e=>[e.from,e.to]))];
  const names=new Map(await Promise.all(addresses.map(async address=>{
    try {return [address,addressName(await lookup(address))];} catch {return [address,''];}
  })));
  const party=address=>`${names.get(address)?names.get(address)+' (שם בסייר)':'ללא שם בסייר'}${watched.has(address)?' · במעקב':''}\n${address||'כתובת לא זמינה'}`;
  const date=new Intl.DateTimeFormat('he-IL',{timeZone:'Asia/Jerusalem',dateStyle:'short',timeStyle:'medium'});
  const lines=shown.map(e=>{
    const [whole,fraction]=cent(e.value).split('.');
    const amount=whole.replace(/\B(?=(\d{3})+(?!\d))/g,',')+(fraction?'.'+fraction:'');
    const direction=watched.has(e.from)&&watched.has(e.to)?'בין ארנקים במעקב':watched.has(e.from)?'יציאה מארנק במעקב':'כניסה לארנק במעקב';
    return `${amount} CENT · ${direction}\nמאת: ${party(e.from)}\nאל: ${party(e.to)}\nזמן: ${date.format(new Date(e.time))} (ישראל)`;
  });
  return `העברת CENT מעל הסף\n\n${lines.join('\n\n')}\n\n${events.length>4?'העברות נוספות באותה עסקה מופיעות בסייר.\n':''}עסקה מאושרת · Incentiv\nhttps://explorer.incentiv.io/tx/${hash}`;
}
