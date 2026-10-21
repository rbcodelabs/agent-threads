// Run after `npm run build`: node scripts/check-mobile-load.cjs dist/main.js
// Exits 1 if main.js can't be evaluated the way Geode mobile loads plugins.
// Mimic Geode mobile: clean realm (no Node globals), require only resolves obsidian/geode/codemirror/lezer.
const vm=require('vm'),fs=require('fs');
const code=fs.readFileSync(process.argv[2]||'dist/main.js','utf8');
let failed=false;
const stub=new Proxy(function(){}, {get:(t,k)=>k==='__esModule'?false:k==='then'?undefined:k===Symbol.toPrimitive?()=>'':stub, apply:()=>stub, construct:()=>stub, set:()=>true});
const log=[];
const hostReq=(s)=>{ if(s==='obsidian'||s==='geode'||/^@(codemirror|lezer)\//.test(s)) return stub; log.push(s); throw new Error('Mobile plugin "claude-threads" cannot load unsupported module "'+s+'".'); };
const ctx=vm.createContext({console,TextEncoder,TextDecoder,URL,URLSearchParams,setTimeout,clearTimeout,setInterval,clearInterval,queueMicrotask,fetch,crypto:globalThis.crypto,performance,AbortController,Event,EventTarget,atob,btoa,structuredClone,DOMException,Blob,File:globalThis.File,FormData,Headers,Request,Response,ReadableStream,WritableStream,TransformStream,WebSocket:globalThis.WebSocket,MessageChannel,BroadcastChannel:globalThis.BroadcastChannel,CustomEvent:globalThis.CustomEvent,navigator:{userAgent:'iPhone'}});
ctx.window=ctx; ctx.self=ctx; ctx.globalThis=ctx;
const fn=vm.runInContext('(function(module,exports,require,fetch){"use strict";\n'+code+'\n})',ctx);
const m={exports:{}};
try{ fn(m,m.exports,hostReq,fetch); const c=m.exports.default??m.exports; console.log('LOADED; export:',typeof c); }
catch(e){ failed=true; console.log('FAIL:',e.message.slice(0,300)); console.log((e.stack||'').split('\n').slice(1,5).join('\n').slice(0,600)); }
console.log('host-refused modules:',[...new Set(log)].join(', '));

process.exit(failed?1:0);
