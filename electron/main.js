// electron/main.js
// 主进程：单实例锁 + 端口协商(持久化) + 拉起两个 Python sidecar +
//         内置 node-api(直接 import server 树) + 健康检查 + 安全窗口 + 进程清理
//
// 设计要点（与接口契约一致）：
// - 端口不硬编码：
//     · API 端口（node-api 内置于主进程）用 net.listen(0) 抢空闲端口并持久化到
//       userData/ports.json，下次优先复用（localStorage 按 origin 隔离，端口稳定才能保留已加密的模型 Key）。
//     · tdx-server / sidecar-server 由各自 exe 用 --port 0 让系统分配端口，
//       再回写 stdout 的 PORT=<实际端口>，主进程 readline 读取后注入 node-api 的 TDX/SIDECAR 环境变量。
// - tdx-server 为主源，必拉起；sidecar-server 为补充源，best-effort，失败仅横幅不阻塞。
//   精简版（extraResources 不含 sidecar-server.exe）自动跳过。
// - node-api 跑在主进程内（Electron 即 Node≥20），无需独立 Node 运行时。
// - 关闭窗口 → taskkill 杀掉两个 Python 子进程树，主进程退出即 node-api 退出。

import { app, BrowserWindow, ipcMain, shell } from 'electron';
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
const SERVICES = [
  { id: 'tdx', exe: 'tdx-server.exe', py: 'tdx/server.py' },
  { id: 'sidecar', exe: 'sidecar-server.exe', py: 'sidecar/server.py' },
];

let mainWindow = null;
let errorWindow = null;
const childPids = new Set();

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
  return process.resourcesPath ? path.join(process.resourcesPath, 'extraResources') : null;
}

// 生产：extraResources/xxx-server.exe；dev：python 源码（需 PYTHON_BIN 指向 venv）
function resolveService(svc) {
  const extra = extraResourcesDir();
  if (extra) {
    // onedir 产物在 extraResources/backend/<id>/<id>-server.exe 子目录内
    const prod = path.join(extra, 'backend', svc.id, svc.exe);
    if (fs.existsSync(prod)) return { cmd: prod, via: 'exe' };
  }
  const pyPath = path.join(app.getAppPath(), svc.py);
  if (fs.existsSync(pyPath)) {
    const pyBin = process.env.PYTHON_BIN || 'python';
    return { cmd: pyBin, pyPath, via: 'py' };
  }
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
      detached: true,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (child.pid) childPids.add(child.pid);
    const out = fs.createWriteStream(path.join(LOG_DIR, `${svc.id}.log`), { flags: 'a' });
    child.stderr?.pipe(out);
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
      log(`[${svc.id}] 进程退出 code=${code}`);
      if (child.pid) childPids.delete(child.pid);
      finish(null);
    });
    setTimeout(() => finish(null), timeoutMs);
  });
}

async function waitForHealth(port, timeoutMs = 30000) {
  const url = `http://127.0.0.1:${port}/api/health`;
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

function showErrorWindow(title, detail) {
  if (errorWindow) { errorWindow.focus(); return; }
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const body =
    `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">` +
    `<style>body{font-family:system-ui,-apple-system,sans-serif;background:#1b1d22;color:#e6e6e6;` +
    `margin:0;padding:32px;display:flex;flex-direction:column;height:100vh;box-sizing:border-box}` +
    `h1{font-size:18px;margin:0 0 12px}p{color:#b9bcc4;line-height:1.6;flex:1}` +
    `.row{display:flex;gap:12px}button{background:#2d6cdf;color:#fff;border:0;border-radius:8px;` +
    `padding:10px 18px;font-size:14px;cursor:pointer}button.ghost{background:#33363d}` +
    `button.danger{background:#c0392b}</style></head><body>` +
    `<h1>${esc(title)}</h1><p>${esc(detail)}</p>` +
    `<div class="row">` +
    `<button onclick="window.__APP_CONFIG__.bridge.openLogDir()">查看日志</button>` +
    `<button class="ghost" onclick="window.__APP_CONFIG__.bridge.retry()">重试</button>` +
    `<button class="danger" onclick="window.__APP_CONFIG__.bridge.quit()">退出</button>` +
    `</div></body></html>`;
  errorWindow = new BrowserWindow({
    width: 560,
    height: 360,
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

  // 2) 主源 tdx（必起）：读 stdout 拿实际端口；拿不到 → 错误窗
  const tdxPort = await spawnAndReadPort(SERVICES[0], 5000);
  if (tdxPort == null) {
    showErrorWindow('主数据源启动失败', '通达信行情服务（tdx-server）5 秒内未回写端口。请点「查看日志」查看 tdx-server.log。');
    return;
  }
  process.env.TDX = `http://127.0.0.1:${tdxPort}`;

  // 3) 补充源 sidecar（best-effort）：先判定「精简版禁用」vs「可能崩溃」，二者 health 状态不同。
  //    · resolveService 返回 null = extraResources 与源码均缺失 = 精简版 → 显式置 SIDECAR_DISABLED=1
  //      （index.mjs 的 sidecarHealth 据此返回 disabled:true，区别于进程崩溃）。
  //    · 否则正常拉起；拉起后 15s 内仍未回写端口 = 进程崩溃/未就绪 → 标 SIDECAR=0，
  //      由 sidecarHealth 标记 processAlive:false（disabled 仍为 false），前端据此区分。
  const sidecarResolved = resolveService(SERVICES[1]);
  if (!sidecarResolved) {
    process.env.SIDECAR_DISABLED = '1';
    log('[sidecar] 精简版未含 sidecar-server.exe，补充源禁用（横幅提示，不阻塞主窗口）');
  } else {
    const sidecarPort = await spawnAndReadPort(SERVICES[1], 15000);
    if (sidecarPort == null) {
      log('[sidecar] 5s 内未回写端口，补充源进程崩溃/未就绪（横幅提示，不阻塞主窗口）');
      process.env.SIDECAR = 'http://127.0.0.1:0';
    } else {
      process.env.SIDECAR = `http://127.0.0.1:${sidecarPort}`;
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
ipcMain.handle('app:open-log-dir', async () => { shell.openPath(LOG_DIR); });
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
