// electron/main.js
// 主进程：单实例锁 + 端口协商(持久化) + 拉起两个 Python sidecar +
//         内置 node-api(直接 import server 树) + 健康检查 + 安全窗口 + 进程清理
//
// 设计要点（与接口契约一致）：
// - 端口不硬编码：
//     · API 端口（node-api 内置于主进程）用 net.listen(0) 抢空闲端口并持久化到
//       userData/ports.json，下次优先复用（localStorage 按 origin 隔离，端口稳定才能保留已加密的模型 Key）。
//     · tdx-server / sidecar-server 用固定端口（tdx=8789、sidecar=8788）拉起，
//       主进程轮询其 /health 接口确认就绪后，注入 node-api 的 TDX/SIDECAR 环境变量。
//       （早期版本用 --port 0 + 读取 stdout 的 PORT=，但 Windows 下 Python pipe 块缓冲导致回写丢失，已弃用。）
// - tdx-server 为主源，必拉起；sidecar-server 为补充源，best-effort，失败仅横幅不阻塞。
//   精简版（extraResources 不含 sidecar-server.exe）自动跳过。
// - node-api 跑在主进程内（Electron 即 Node≥20），无需独立 Node 运行时。
// - 关闭窗口 → taskkill 杀掉两个 Python 子进程树，主进程退出即 node-api 退出。

import { app, BrowserWindow, ipcMain, shell, clipboard } from 'electron';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;

const APP_VERSION = app.getVersion() || '0.1.0';
const USER_DATA = app.getPath('userData');
const LOG_DIR = path.join(USER_DATA, 'logs');
const PORTS_FILE = path.join(USER_DATA, 'ports.json');

// 两个 Python 后端；exe 由 PyInstaller 产出（batch 2），dev 回退到 python 源码。
// required=true 表示主源，缺失时 node-api 会自动降级腾讯/新浪（不致命）。
// 注意：PyInstaller onedir 产物目录名带 -server 后缀（tdx-server/、sidecar-server/），
// 与 svc.id（tdx/sidecar）不同，故单独用 dir 字段显式声明，避免路径拼接错位。
const SERVICES = [
  { id: 'tdx', dir: 'tdx-server', exe: 'tdx-server.exe', py: 'tdx/server.py' },
  { id: 'sidecar', dir: 'sidecar-server', exe: 'sidecar-server.exe', py: 'sidecar/server.py' },
];

let mainWindow = null;
let errorWindow = null;
const childPids = new Set();
// 最近一次启动诊断文本，供错误窗「复制诊断信息」按钮读取。
// 必须在模块顶层声明：ESM 严格模式下给未声明变量赋值会抛 ReferenceError，
// 曾因漏声明导致 tdx 失败分支崩溃（错误窗建不出来、主进程直接退出）。
let lastDiagText = '';

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { fs.appendFileSync(path.join(LOG_DIR, 'main.log'), line); } catch { /* ignore */ }
  console.log(msg);
}

function ensureDirs() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('close', () => resolve(true));
    srv.listen(port, '127.0.0.1', () => srv.close());
  });
}

// 优先复用上次端口（保证 localStorage/模型 Key 不丢），被占用才换新的
async function loadPorts() {
  try { return JSON.parse(fs.readFileSync(PORTS_FILE, 'utf8')); } catch { return null; }
}
async function savePorts(p) {
  fs.writeFileSync(PORTS_FILE, JSON.stringify(p, null, 2));
}

function extraResourcesDir() {
  return process.resourcesPath || null;
}

// 生产：extraResources/backend/<dir>/<exe>；dev：python 源码（需 PYTHON_BIN 指向 venv）
function resolveService(svc) {
  const extra = extraResourcesDir();
  if (extra) {
    // onedir 产物目录名为 svc.dir（带 -server 后缀），exe 在其内
    const prod = path.join(extra, 'backend', svc.dir, svc.exe);
    if (fs.existsSync(prod)) return { cmd: prod, via: 'exe' };
    // 诊断保险：记录尝试过的完整路径，便于错误窗/日志定位“找不到 exe”
    log(`[${svc.id}] 未命中 exe（尝试路径）：${prod}`);
  }
  const pyPath = path.join(app.getAppPath(), svc.py);
  if (fs.existsSync(pyPath)) {
    const pyBin = process.env.PYTHON_BIN || 'python';
    return { cmd: pyBin, pyPath, via: 'py' };
  }
  // 诊断保险：prod 与 py 均缺失时，把两者完整路径都记到 main.log
  log(`[${svc.id}] 未找到可执行文件：prod=${extra ? path.join(extra, 'backend', svc.dir, svc.exe) : '(无 extraResources)'}；py=${pyPath}`);
  return null;
}

// 拉起一个 Python 后端，读取其 stdout 回写的 PORT=<实际端口>。
// tdx（主源）5s 超时；sidecar 15s（akshare 冷启动实测 ~8s，避免把“健康但慢”误判为崩溃）。
// 任一超时或进程异常退出均返回 null（sidecar 失败仅横幅不阻塞；tdx 失败由调用方弹错误窗）。
// TODO(3b): sidecar 的 akshare 改为懒加载——启动只 bind + 回写 PORT，akshare import 延迟到首次调用；
//           根因解决后 5s 超时即够，可把 sidecar 也调回 5s。
function spawnAndReadPort(svc, timeoutMs = 5000) {
  const resolved = resolveService(svc);
  if (!resolved) {
    log(`[${svc.id}] 未找到可执行文件（extraResources 与源码均缺失），跳过`);
    return Promise.resolve(null);
  }
  const t0 = Date.now();
  return new Promise((resolve) => {
    // 点 C：显式 UTF-8，避免 Windows 中文 locale 下 stdout 编码问题
    const env = { ...process.env, PYTHONIOENCODING: 'utf-8' };
    const args = resolved.via === 'exe' ? ['--port', '0'] : [resolved.pyPath, '--port', '0'];
    const child = spawn(resolved.cmd, args, {
      windowsHide: true,
      detached: false,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (child.pid) childPids.add(child.pid);
    const out = fs.createWriteStream(path.join(LOG_DIR, `${svc.id}.log`), { flags: 'a' });
    child.stderr?.pipe(out);
    // 诊断加固：stderr 同时写入 Electron 主进程日志（main.log），便于排查子进程异常
    child.stderr?.on('data', (chunk) => {
      log(`[${svc.id}][stderr] ${chunk.toString('utf8').trim()}`);
    });
    const rl = readline.createInterface({ input: child.stdout });
    let done = false;
    const finish = (port) => {
      if (done) return;
      done = true;
      try { rl.close(); } catch { /* ignore */ }
      resolve(port);
    };
    rl.on('line', (line) => {
      out.write('[stdout] ' + line + '\n');
      const m = /^PORT=(\d+)$/.exec(line.trim());
      if (m) {
        const dt = ((Date.now() - t0) / 1000).toFixed(1);
        log(`[${svc.id}] PORT 回写耗时 ${dt}s`);
        finish(Number(m[1]));
      }
    });
    child.on('exit', (code) => {
      const dt = ((Date.now() - t0) / 1000).toFixed(1);
      log(`[${svc.id}] 进程退出 code=${code}（耗时 ${dt}s）`);
      if (child.pid) childPids.delete(child.pid);
      finish(null);
    });
    setTimeout(() => finish(null), timeoutMs);
  });
}

async function waitForHealth(port, timeoutMs = 30000, healthPath = '/api/health') {
  const url = `http://127.0.0.1:${port}${healthPath}`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.ok) { log(`[health] OK @${port}`); return true; }
    } catch { /* not ready */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

// 方案 B：固定端口 + 轮询 /health 拉起 Python 后端，不再依赖 stdout 的 PORT=（规避 Windows
// 下 Python 子进程 pipe 块缓冲导致回写丢失）。返回 { ok:true } 或 { ok:false, ...诊断 }。
// 诊断含 pid / exitCode / exitTime / healthUrl / 最后 20 行 stderr，供错误窗直接展示，免去翻日志。
async function spawnFixedPort(svc, port, timeoutMs = 15000) {
  const healthUrl = `http://127.0.0.1:${port}/health`;
  const resolved = resolveService(svc);
  if (!resolved) {
    log(`[${svc.id}] 未找到可执行文件（extraResources 与源码均缺失），跳过`);
    return {
      ok: false, id: svc.id, reason: 'missing-exe', pid: null, exitCode: null, exitTime: null,
      healthUrl, stderr: [`未找到可执行文件：extraResources 与源码均缺失`],
    };
  }
  const env = { ...process.env, PYTHONIOENCODING: 'utf-8' };
  const args = resolved.via === 'exe' ? ['--port', String(port)] : [resolved.pyPath, '--port', String(port)];
  // exe 模式 cwd 落到 exe 所在目录（保证 _internal/ 相对资源可解析）；py 模式落到 server.py 目录。
  const cwd = resolved.via === 'exe' ? path.dirname(resolved.cmd) : path.dirname(resolved.pyPath);
  const child = spawn(resolved.cmd, args, {
    cwd,
    windowsHide: true,
    detached: false,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const pid = child.pid || null;
  if (pid) childPids.add(pid);
  const out = fs.createWriteStream(path.join(LOG_DIR, `${svc.id}.log`), { flags: 'a' });
  child.stderr?.pipe(out);
  const stderrLines = [];
  child.stderr?.on('data', (chunk) => {
    const txt = chunk.toString('utf8').trim();
    log(`[${svc.id}][stderr] ${txt}`);
    for (const line of txt.split(/\r?\n/)) {
      if (!line) continue;
      stderrLines.push(line);
      if (stderrLines.length > 20) stderrLines.shift();
    }
  });
  let exitCode = null;
  let exitTime = null;
  child.on('exit', (code) => {
    exitCode = code;
    exitTime = new Date().toISOString();
    log(`[${svc.id}] 进程退出 code=${code}`);
    if (pid) childPids.delete(pid);
  });
  log(`[${svc.id}] 已按固定端口 ${port} 拉起（pid=${pid}），开始轮询 /health（超时 ${Math.round(timeoutMs / 1000)}s）`);
  const ok = await waitForHealth(port, timeoutMs, '/health');
  if (ok) return { ok: true, id: svc.id, pid, healthUrl };
  return {
    ok: false, id: svc.id,
    reason: exitCode != null ? 'exited' : 'timeout',
    pid, exitCode, exitTime, healthUrl,
    cmd: `${resolved.cmd} ${args.join(' ')}`,
    cwd,
    stderr: stderrLines.slice(-20),
  };
}

// 生产态 server 经 asarUnpack 抽离到 app.asar.unpacked，ESM import 才能解析
function serverEntry() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'app.asar.unpacked', 'server', 'index.mjs');
  }
  return path.join(app.getAppPath(), 'server', 'index.mjs');
}

function createWindow(apiPort) {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    title: 'A股博弈雷达',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  // preload 读取这两个 env 注入 window.__APP_CONFIG__
  process.env.APP_API_BASE = `http://127.0.0.1:${apiPort}`;
  process.env.APP_VERSION = APP_VERSION;
  const url = isDev ? 'http://localhost:5173/' : `http://127.0.0.1:${apiPort}/`;
  win.loadURL(url);
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { mainWindow = null; });
  return win;
}

function showErrorWindow(title, detail, diag) {
  if (errorWindow) { errorWindow.focus(); return; }
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // 把诊断信息直接渲染进错误窗，避免用户去翻日志文件；同时存到 lastDiagText 供「复制诊断信息」使用。
  let diagHtml = '';
  lastDiagText = '';
  if (diag) {
    const status = diag.pid
      ? (diag.exitCode != null ? `已退出（exit code=${diag.exitCode}）` : '仍在运行')
      : '未拉起（未找到可执行文件或启动失败）';
    const stderrBlock = (diag.stderr && diag.stderr.length)
      ? diag.stderr.join('\n')
      : '（无 stderr 输出）';
    lastDiagText =
`【A股博弈雷达 启动诊断】
服务: ${diag.id || ''}
状态: ${status}
PID: ${diag.pid != null ? diag.pid : '未知'}
退出时间: ${diag.exitTime || '—'}
Health URL: ${diag.healthUrl || ''}
启动命令: ${diag.cmd || ''}
工作目录: ${diag.cwd || ''}
日志目录: ${LOG_DIR}
最后 20 行 stderr:
${stderrBlock}`;
    diagHtml =
      `<div class="diag"><div class="diag-title">诊断信息（无需打开日志文件）</div>` +
      `<pre>${esc(lastDiagText)}</pre></div>`;
  }

  const copyBtn = diagHtml
    ? `<button class="ghost" onclick="window.__APP_CONFIG__.bridge.copyDiag()">复制诊断信息</button>`
    : '';
  const body =
    `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">` +
    `<style>body{font-family:system-ui,-apple-system,sans-serif;background:#1b1d22;color:#e6e6e6;` +
    `margin:0;padding:24px;display:flex;flex-direction:column;height:100vh;box-sizing:border-box}` +
    `h1{font-size:18px;margin:0 0 10px}p{color:#b9bcc4;line-height:1.6}` +
    `.diag{margin:12px 0;background:#14161a;border:1px solid #2a2d34;border-radius:8px;padding:12px;flex:1;overflow:auto}` +
    `.diag-title{color:#9aa0aa;font-size:12px;margin-bottom:6px}` +
    `.diag pre{margin:0;white-space:pre-wrap;word-break:break-all;font-size:12px;color:#cfd3da;line-height:1.5}` +
    `.row{display:flex;gap:10px;flex-wrap:wrap}button{background:#2d6cdf;color:#fff;border:0;border-radius:8px;` +
    `padding:10px 16px;font-size:14px;cursor:pointer}button.ghost{background:#3a3e47}` +
    `button.danger{background:#c0392b}</style></head><body>` +
    `<h1>${esc(title)}</h1><p>${esc(detail)}</p>` +
    diagHtml +
    `<div class="row">` +
    `<button onclick="window.__APP_CONFIG__.bridge.openLogDir()">查看日志</button>` +
    copyBtn +
    `<button class="ghost" onclick="window.__APP_CONFIG__.bridge.retry()">重试</button>` +
    `<button class="danger" onclick="window.__APP_CONFIG__.bridge.quit()">退出</button>` +
    `</div></body></html>`;
  errorWindow = new BrowserWindow({
    width: 660,
    height: 560,
    title: '启动失败',
    show: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false, preload: path.join(__dirname, 'preload.js') },
  });
  errorWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(body));
  errorWindow.on('closed', () => { errorWindow = null; });
}

async function killChildren() {
  for (const pid of childPids) {
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } catch { /* ignore */ }
  }
  childPids.clear();
}

async function startup() {
  ensureDirs();

  // 生产态：前端构建产物 dist 经 electron-builder 作为 extraResource 落入 resources/dist，
  // 由 node-api 作为静态根托管（SPA fallback）。dev 不设置，node-api 跳过静态托管走 vite dev server。
  // 具体由 electron-builder.yml 的 extraResources 保证 dist 到位（3b 范围）。
  if (app.isPackaged) {
    process.env.APP_STATIC_DIR = path.join(process.resourcesPath, 'dist');
  }

  // 1) API 端口（node-api 内置于主进程）：优先复用上次端口，保证 localStorage/模型 Key 稳定
  const saved = await loadPorts();
  const apiPort = (saved?.api && (await isPortFree(saved.api))) ? saved.api : await getFreePort();
  await savePorts({ api: apiPort });
  process.env.PORT = String(apiPort);

  // 2) 主源 tdx（必起）：固定端口 8789 + 轮询 /health；超时 → 错误窗（含诊断）
  const TDX_TIMEOUT_MS = 15000;
  const tdxResult = await spawnFixedPort(SERVICES[0], 8789, TDX_TIMEOUT_MS);
  if (!tdxResult.ok) {
    showErrorWindow('主数据源启动失败', `通达信行情服务（tdx-server）${Math.round(TDX_TIMEOUT_MS / 1000)} 秒内 health 探测超时（端口 8789）。详见下方诊断信息，无需打开日志文件。`, tdxResult);
    return;
  }
  process.env.TDX = 'http://127.0.0.1:8789';

  // 3) 补充源 sidecar（best-effort）：固定端口 8788 + 轮询 /health；失败仅横幅不阻塞。
  //    · resolveService 返回 null = extraResources 与源码均缺失 = 精简版 → 显式置 SIDECAR_DISABLED=1
  //      （index.mjs 的 sidecarHealth 据此返回 disabled:true，区别于进程崩溃）。
  //    · 否则固定端口拉起；15s 内 /health 仍超时 = 进程崩溃/未就绪 → 标 SIDECAR=0，
  //      由 sidecarHealth 标记 processAlive:false（disabled 仍为 false），前端据此区分。
  const sidecarResolved = resolveService(SERVICES[1]);
  if (!sidecarResolved) {
    process.env.SIDECAR_DISABLED = '1';
    log('[sidecar] 精简版未含 sidecar-server.exe，补充源禁用（横幅提示，不阻塞主窗口）');
  } else {
    const sidecarResult = await spawnFixedPort(SERVICES[1], 8788, 15000);
    if (!sidecarResult.ok) {
      log('[sidecar] 15s 内 health 探测超时，补充源进程崩溃/未就绪（横幅提示，不阻塞主窗口）');
      process.env.SIDECAR = 'http://127.0.0.1:0';
    } else {
      process.env.SIDECAR = 'http://127.0.0.1:8788';
    }
  }

  // 4) 内置 node-api：动态 import（顶层 listen(PORT)）
  try {
    await import(pathToFileURL(serverEntry()).href);
  } catch (e) {
    log('[server] 导入失败: ' + (e && e.stack || e));
    showErrorWindow('后端启动失败', 'node-api 加载异常：' + (e && e.message || e));
    return;
  }

  // 5) 健康检查（≤30s）通过后建窗口
  const ok = await waitForHealth(apiPort, 30000);
  if (!ok) {
    showErrorWindow('后端无响应', `30s 内未收到 /api/health（端口 ${apiPort}）。请点「查看日志」排查。`);
    return;
  }
  mainWindow = createWindow(apiPort);
}

// ---- IPC：错误窗按钮 ----
ipcMain.handle('app:open-log-dir', async () => {
  try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch { /* ignore */ }
  const err = await shell.openPath(LOG_DIR);
  if (err) log('[open-log-dir] shell.openPath 返回错误: ' + err);
  return err;
});
ipcMain.handle('app:copy-diagnostic', async () => {
  try { if (lastDiagText) clipboard.writeText(lastDiagText); return true; } catch { return false; }
});
ipcMain.handle('app:retry', async () => { app.relaunch(); app.exit(0); });
ipcMain.handle('app:quit', async () => { app.quit(); });

// ---- 关闭清理 ----
app.on('before-quit', (e) => {
  e.preventDefault();
  killChildren().then(() => app.exit(0));
});

// ---- 单实例锁 ----
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
  });
  app.whenReady().then(startup);
}
