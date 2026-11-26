// scripts/dict-info-check.mjs —— P2.7 字典信息入口接线验收
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const BASE = process.argv[2] || 'http://127.0.0.1:5173/';
const PORT = Number(process.argv[3] || 9335);
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const USER_DATA = 'C:/Users/tony/WorkBuddy/2026-09-28-08-13-22/.cdp-dict-profile';
for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) delete process.env[k];
process.env.NO_PROXY = '127.0.0.1,localhost';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (ok, label, extra = '') => { if (ok) { pass++; console.log('  ✓ ' + label + (extra ? ' → ' + extra : '')); } else { fail++; console.log('  ✗ ' + label + (extra ? ' → ' + extra : '')); } };
class CDP {
  constructor(url) { this.url = url; this.id = 0; this.p = new Map(); }
  async connect() { this.ws = new WebSocket(this.url); await new Promise((r, j) => { this.ws.onopen = r; this.ws.onerror = j; }); this.ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && this.p.has(m.id)) { const x = this.p.get(m.id); this.p.delete(m.id); m.error ? x.j(new Error(JSON.stringify(m.error))) : x.r(m.result); } }; }
  send(method, params = {}) { const id = ++this.id; return new Promise((r, j) => { this.p.set(id, { r, j }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async eval(expr) { const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result?.value; }
  async shot(p) { const r = await this.send('Page.captureScreenshot', { format: 'png' }); writeFileSync(p, Buffer.from(r.data, 'base64')); }
  close() { try { this.ws.close(); } catch {} }
}
(async () => {
  const chrome = spawn(CHROME, ['--remote-debugging-port=' + PORT, '--user-data-dir=' + USER_DATA, '--headless=new', '--disable-gpu', '--no-first-run', '--window-size=1440,865', BASE], { stdio: 'ignore' });
  let cdp;
  try {
    let ok = false;
    for (let i = 0; i < 24; i++) { await sleep(500); try { const r = await fetch('http://127.0.0.1:' + PORT + '/json/version', { signal: AbortSignal.timeout(800) }); if (r.ok) { ok = true; break; } } catch {} }
    if (!ok) throw new Error('CDP 未就绪');
    const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
    const page = list.find((t) => t.type === 'page' && String(t.url).includes(String(PORT))) || list.find((t) => t.type === 'page');
    cdp = new CDP(page.webSocketDebuggerUrl); await cdp.connect(); await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
    await sleep(2500);
    const clicked = await cdp.eval(`(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='备份'); if(!b)return false; b.click(); return true; })()`);
    check(clicked, '点开「备份」入口');
    await sleep(900);
    const info = await cdp.eval(`(() => {
      const box=document.querySelector('.backup-dict');
      if(!box)return {ok:false};
      return { ok:true, text: box.innerText.replace(/\\n/g,' | '), code: [...box.querySelectorAll('code')].map(c=>c.textContent) };
    })()`);
    check(info.ok, '字典信息块存在');
    if (info.ok) {
      check(info.text.includes('5580'), '条数显示 5580', info.text.slice(0, 120));
      check(/更新时间：\d{4}\//.test(info.text) || info.text.includes('2026/11/26'), 'builtAt 本地化显示', info.text.slice(0, 160));
      check(info.code.some((c) => c.includes('build-stock-index.mjs')), '重建命令写明', JSON.stringify(info.code));
      check(info.text.includes('pinyin-pro'), '依赖说明写明');
      await cdp.shot('C:/Users/tony/A-mab/data/dict-info-backup.png');
    }
    console.log('\n结果 ' + pass + '/' + (pass + fail));
    if (fail) process.exitCode = 1;
  } finally { if (cdp) cdp.close(); try { process.kill(chrome.pid); } catch {} }
})().catch((e) => { console.error('ERR ' + e.message); process.exit(1); });
