// Loads a built plugin (manifest.json/main.js/styles.css in <dir>) into Geode's REAL mobile renderer
// running in real WebKit (iPhone 13 profile), enables it, opens its mobile view, and fails on any
// load error / console error. This is the check that would have caught "can't find variable
// SharedArrayBuffer" and the node:crypto dynamic import. Needs a Geode checkout with `npm ci` and
// `npm run build:mobile` done, plus `npx playwright install webkit`.
//   GEODE_DIR=~/projects/geode node scripts/check-mobile-geode.mjs dist
import {webkit,devices} from 'playwright-core';
import fs from 'fs';
import { WebSocketServer } from 'ws';
import https from 'https';
import { execFileSync } from 'child_process';
import os from 'os'; import path from 'path';
// Local stand-in for the paired desktop/relay: records the mobile connection and pushes a snapshot.
// Geode mobile's CSP only allows wss:, so the stand-in relay needs TLS (self-signed; context ignores cert errors).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-'));
execFileSync('openssl', ['req','-x509','-newkey','rsa:2048','-nodes','-keyout',`${tmp}/k.pem`,'-out',`${tmp}/c.pem`,'-days','2','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' });
const server = https.createServer({ key: fs.readFileSync(`${tmp}/k.pem`), cert: fs.readFileSync(`${tmp}/c.pem`) });
const wss = new WebSocketServer({ server }); await new Promise(r => server.listen(0, '127.0.0.1', r));
const relayPort = server.address().port; let relayPath = null;
wss.on('connection', (sock, req) => { relayPath = req.url; sock.send(JSON.stringify({ type: 'snapshot', activeThreadId: null, threads: [{ id: 't1', title: 'Hello from relay', cwd: '/x', messages: [{ id: 'm1', role: 'user', content: 'ping from desktop', timestamp: Date.now() }], createdAt: Date.now(), updatedAt: Date.now() }] })); });
const dir=process.argv[2]||'dist'; const geodeDir=process.env.GEODE_DIR||`${process.env.HOME}/projects/geode`; const url=`file://${geodeDir}/dist/mobile/index.html`; let failed=false;
const files=Object.fromEntries(['main.js','manifest.json','styles.css'].map(f=>[f,fs.readFileSync(`${dir}/${f}`,'utf8')]));
const b=await webkit.launch(); const ctx=await b.newContext({...devices['iPhone 13'], ignoreHTTPSErrors: true}); const page=await ctx.newPage();
const logs=[]; page.on('console',m=>logs.push(`[${m.type()}] ${m.text()}`.slice(0,400))); page.on('pageerror',e=>logs.push('[pageerror] '+String(e).slice(0,400)));
await page.addInitScript(()=>{ const m=new Map(); const ls={getItem:k=>m.has(k)?m.get(k):null,setItem:(k,v)=>{m.set(String(k),String(v))},removeItem:k=>{m.delete(k)},clear:()=>m.clear(),key:i=>[...m.keys()][i]??null,get length(){return m.size}}; Object.defineProperty(window,'localStorage',{value:ls,configurable:true}); });
await page.goto(url);
await page.waitForSelector('[aria-label="Mobile navigation"]',{state:'attached',timeout:20000});
console.log('SAB in page:', await page.evaluate(()=>typeof SharedArrayBuffer));
const res=await page.evaluate(async ({files,relay})=>{
  const vf=window.hostServices.vaultFiles; const d='.geode/plugins/claude-threads';
  await vf.mkdir(d); for (const [n,c] of Object.entries(files)) await vf.write(`${d}/${n}`,c);
  await vf.write(`${d}/data.json`, JSON.stringify({ remoteAccess: { enabled: true, roomId: 'testroom', relayUrl: relay } }));
  await window.geode.writeConfig('plugins',['claude-threads']);
  try { await window.app.pluginManager.initialize(); } catch(e){ return 'initialize threw: '+e.message; }
  const pm=window.app.pluginManager;
  return {enabled: pm.isEnabled('claude-threads'), keys: Object.keys(pm).slice(0,30)};
},{files,relay:`wss://127.0.0.1:${relayPort}`});
console.log('RESULT',JSON.stringify(res));
await page.waitForTimeout(3000);
const info=await page.evaluate(()=>{ const pm=window.app.pluginManager; const cm=window.app.commands; const cmds=cm?.listCommands?.()||Object.values(cm?.commands||{}); return {loadErrors: JSON.stringify([...(pm.loadErrors?.entries?.()||[])]).slice(0,500), loaded:[...(pm.loaded?.keys?.()||[])], cmdApi: cm?Object.keys(cm).slice(0,10):null, cmds: cmds.map(c=>c.id).filter(i=>/claude|thread/i.test(i)).slice(0,40)}; });
console.log('INFO',JSON.stringify(info));
console.log(logs.filter(l=>!/Download the React|favicon/.test(l)).slice(0,25).join('\n'));
const view=await page.evaluate(async ()=>{ try{ const ws=window.app.workspace; const p=window.app.pluginManager.get?.('claude-threads')||window.app.plugins?.plugins?.['claude-threads']; if(p?.activateMobileView){ await p.activateMobileView(); } else { const leaf=ws.getRightLeaf(false); await leaf.setViewState({type:'claude-threads:mobile',active:true}); ws.revealLeaf(leaf);} await new Promise(r=>setTimeout(r,2500)); return {all:document.body.innerText.includes('Hello from relay'), types:(ws.getLeavesOfType?ws.getLeavesOfType('claude-threads:mobile').length:null), text:document.querySelector('.claude-threads-mobile, [class*=mobile-view], [class*=pairing]')?.textContent?.slice(0,200)}; }catch(e){ return 'ERR '+e.message+' '+(e.stack||'').slice(0,300);} });
console.log('VIEW',JSON.stringify(view)); console.log(logs.slice(-8).join('\n'));
const errs=logs.filter(l=>/^\[(error|pageerror)\]/.test(l));
if(!res.enabled||errs.length||typeof view!=='object'||!view.all || !relayPath?.startsWith('/room/testroom?role=mobile')){ failed=true; console.log('FAILED', errs.join('\n')); } else console.log('PASS: plugin enabled in WebKit, connected to relay, rendered pushed thread');
console.log('relay path:',relayPath); await b.close(); wss.close(); server.close(); process.exit(failed?1:0);
