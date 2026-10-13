/**
 * 启动通达信直连行情服务（主数据源）。
 *
 * 单独包一层的原因：
 *   pytdx 装在系统 Python 3.13.12，而 AkShare 装在托管 venv(envs/default)，
 *   两者不在同一个解释器里，不能用同一条命令启动。
 *   这里按「先找 pytdx 可用的解释器，找不到再提示安装」的顺序解析，
 *   避免 npm run dev 因为环境问题整个起不来。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const CANDIDATES = [
  'C:\\Users\\tony\\.workbuddy\\binaries\\python\\versions\\3.13.12\\python.exe',
  'C:\\Users\\tony\\.workbuddy\\binaries\\python\\envs\\default\\Scripts\\python.exe',
  'python',
];

function findPython() {
  for (const p of CANDIDATES) {
    if (p === 'python') return p; // 兜底交给 PATH
    if (existsSync(p)) return p;
  }
  return 'python';
}

const py = findPython();
console.log('[tdx] python=' + py);
const child = spawn(py, ['tdx/server.py'], { stdio: 'inherit', shell: false });

child.on('error', (e) => {
  console.error('[tdx] 启动失败：' + e.message);
  console.error('[tdx] 请确认已安装 pytdx： pip install pytdx');
});
child.on('exit', (code) => {
  console.log('[tdx] 退出 code=' + code);
});
