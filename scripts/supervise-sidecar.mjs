/**
 * sidecar 看门狗：常驻监控 AkShare sidecar(8788)。
 *
 * 背景：sidecar 的 py_mini_racer 原生库会间歇性崩溃（exit 2147483651，
 * Check failed: !IsConfigurablePoolInitialized()），导致板块/资金流/分时功能整段断掉。
 * 这里用 node 监督进程在 sidecar 退出后自动重拉，崩一次最多中断 ~2s。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const VENV = 'C:\\Users\\tony\\.workbuddy\\binaries\\python\\envs\\default\\Scripts\\python.exe';
const py = existsSync(VENV) ? VENV : 'python';
const MAX_RESTARTS = 1000; // 近乎无限，靠进程常驻
let restarts = 0;

function start() {
  const child = spawn(py, ['sidecar/server.py'], { stdio: 'inherit', shell: false });
  console.log('[supervisor] sidecar started pid=' + child.pid + ' (restart #' + restarts + ')');
  child.on('error', (e) => console.error('[supervisor] spawn error: ' + e.message));
  child.on('exit', (code, signal) => {
    restarts++;
    console.log('[supervisor] sidecar exited code=' + code + ' signal=' + signal + ' (restart #' + restarts + ')');
    if (restarts > MAX_RESTARTS) {
      console.error('[supervisor] 超过最大重启次数，停止。');
      process.exit(1);
    }
    console.log('[supervisor] 2s 后重拉 sidecar ...');
    setTimeout(start, 2000);
  });
}

console.log('[supervisor] sidecar watchdog started, python=' + py);
start();
