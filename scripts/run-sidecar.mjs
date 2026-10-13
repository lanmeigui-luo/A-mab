/** 启动 AkShare sidecar（补充源：板块 / 资金流 / 涨停池） */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const VENV = 'C:\\Users\\tony\\.workbuddy\\binaries\\python\\envs\\default\\Scripts\\python.exe';
const py = existsSync(VENV) ? VENV : 'python';

console.log('[sidecar] python=' + py);
const child = spawn(py, ['sidecar/server.py'], { stdio: 'inherit', shell: false });

child.on('error', (e) => {
  console.error('[sidecar] 启动失败：' + e.message);
  console.error('[sidecar] 请确认已安装 akshare： pip install akshare');
});
child.on('exit', (code) => {
  console.log('[sidecar] 退出 code=' + code);
});
