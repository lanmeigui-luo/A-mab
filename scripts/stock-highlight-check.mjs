// scripts/stock-highlight-check.mjs —— 候选命中高亮接线验收（CDP 真实浏览器）
// 用法：node scripts/stock-highlight-check.mjs [baseUrl] [cdpPort]
// 依赖：系统 Chrome；dev server 已在 baseUrl 运行。全程同进程起停 Chrome。
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const BASE = process.argv[2] || 'http://127.0.0.1:5173/';
const PORT = Number(process.argv[3] || 9333);
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const USER_DATA = 'C:/Users/tony/WorkBuddy/2026-09-28-08-13-22/.cdp-hl-profile';
const SHOT_DIR = 'C:/Users/tony/A-mab/data/';

// 坑 B：代理会把 127.0.0.1 也代理掉 → 起子进程前清掉
for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) delete process.env[k];
process.env.NO_PROXY = '127.0.0.1,localhost';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (ok, label, extra = '') => {
  if (ok) { pass++; console.log('  ✓ ' + label + (extra ? ' → ' + extra : '')); }
  else { fail++; console.log('  ✗ ' + label + (extra ? ' → ' + extra : '')); }
};

class CDP {
  constructor(url) { this.url = url; this.id = 0; this.p = new Map(); }
  async connect() {
    this.ws = new WebSocket(this.url);
    await new Promise((r, j) => { this.ws.onopen = r; this.ws.onerror = j; });
    this.ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.p.has(m.id)) { const x = this.p.get(m.id); this.p.delete(m.id); m.error ? x.j(new Error(JSON.stringify(m.error))) : x.r(m.result); }
    };
  }
  send(method, params = {}) { const id = ++this.id; return new Promise((r, j) => { this.p.set(id, { r, j }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async eval(expr) { const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result?.value; }
  async shot(path) { const r = await this.send('Page.captureScreenshot', { format: 'png' }); writeFileSync(path, Buffer.from(r.data, 'base64')); }
  close() { try { this.ws.close(); } catch {} }
}

async function main() {
  console.log('=== 候选命中高亮接线验收 ===');
  console.log('BASE=' + BASE + ' CDP=' + PORT);
  // 坑 A：起浏览器→连→测→kill 全在同一进程
  const chrome = spawn(CHROME, [
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + USER_DATA,
    '--headless=new', '--disable-gpu', '--no-first-run', '--window-size=1440,865', BASE,
  ], { stdio: 'ignore' });
  let cdp;
  try {
    let ok = false;
    for (let i = 0; i < 24; i++) {
      await sleep(500);
      try { const r = await fetch('http://127.0.0.1:' + PORT + '/json/version', { signal: AbortSignal.timeout(800) }); if (r.ok) { ok = true; break; } } catch {}
    }
    if (!ok) throw new Error('CDP 未就绪');
    // 坑 H：带 URL 启动，按端口筛 page target
    const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
    const page = list.find((t) => t.type === 'page' && String(t.url).includes(String(PORT))) || list.find((t) => t.type === 'page');
    if (!page) throw new Error('无 page target');
    cdp = new CDP(page.webSocketDebuggerUrl);
    await cdp.connect(); await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
    await sleep(2500);

    // 定位添加框（combobox）
    const found = await cdp.eval(`(() => {
      const inp = [...document.querySelectorAll('input')].find(x => (x.placeholder||'').includes('代码 / 名称 / 拼音'));
      if (!inp) return { ok:false, inputs:[...document.querySelectorAll('input')].map(x=>x.placeholder) };
      inp.focus();
      return { ok:true, placeholder: inp.placeholder };
    })()`);
    check(found.ok, '添加框存在', found.ok ? found.placeholder : JSON.stringify(found.inputs));

    const typeQuery = async (q) => cdp.eval(`(() => {
      const inp = [...document.querySelectorAll('input')].find(x => (x.placeholder||'').includes('代码 / 名称 / 拼音'));
      if (!inp) return {err:'no input'};
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(inp, ${JSON.stringify(q)});
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      return 1;
    })()`);

    // A. cdjs → ini 高亮
    await typeQuery('cdjs'); await sleep(900);
    const a = await cdp.eval(`(() => {
      const items = [...document.querySelectorAll('.combo-item')];
      const marks = [...document.querySelectorAll('.combo-item mark.combo-hit')];
      return { count: items.length, first: items[0]?.innerText?.replace(/\\n/g,' ') || '',
               marks: marks.map(m => m.textContent), markColor: marks[0] ? getComputedStyle(marks[0]).color : null,
               html: items[0]?.innerHTML || '' };
    })()`);
    check(a.count > 0, 'cdjs 有候选', 'count=' + a.count);
    check(a.first.includes('崇达技术') && a.first.includes('002815'), '首条=崇达技术(002815)', a.first);
    check(a.marks.includes('cdjs'), 'cdjs 命中段有 <mark>', JSON.stringify(a.marks));
    check(a.markColor === 'rgb(220, 38, 38)', '<mark> 标红', String(a.markColor));
    await cdp.shot(SHOT_DIR + 'highlight-A-cdjs.png');

    // B. 崇达 → name 高亮
    await typeQuery('崇达'); await sleep(900);
    const b = await cdp.eval(`(() => {
      const items = [...document.querySelectorAll('.combo-item')];
      const marks = [...document.querySelectorAll('.combo-item mark.combo-hit')];
      return { count: items.length, first: items[0]?.innerText?.replace(/\\n/g,' ') || '',
               marks: marks.map(m => m.textContent) };
    })()`);
    check(b.count > 0, '崇达 有候选', 'count=' + b.count);
    check(b.marks.includes('崇达'), '崇达 命中段有 <mark>', JSON.stringify(b.marks));
    await cdp.shot(SHOT_DIR + 'highlight-B-name.png');

    console.log('\n结果 ' + pass + '/' + (pass + fail));
    if (fail) process.exitCode = 1;
  } finally {
    if (cdp) cdp.close();
    try { process.kill(chrome.pid); } catch {}
  }
}
main().catch((e) => { console.error('ERR ' + e.message); process.exit(1); });
