/**
 * dev-server.mjs —— 带日志持久化的 dev server 启动器
 *
 * 用 concurrently 跑 npm run dev 时，server 的 stdout 只挂在终端上，
 * 会话结束/挂机后无法回溯（2026-11-16 排查 15:05 定时任务时踩过）。
 * 这里把 stdout/stderr 同时 tee 到 logs/server.log（追加，带启动分隔），
 * 终端输出保持不变，不影响热更新与调试。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const logsDir = path.join(root, 'logs');
fs.mkdirSync(logsDir, { recursive: true });
const logFile = path.join(logsDir, 'server.log');
const out = fs.createWriteStream(logFile, { flags: 'a' });
out.write('\n===== dev server start ' + new Date().toISOString() + ' =====\n');

const child = spawn(process.execPath, ['server/index.mjs'], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
});
for (const [prefix, stream] of [['[out] ', child.stdout], ['[err] ', child.stderr]]) {
  stream.on('data', (chunk) => {
    process.stdout.write(chunk);
    out.write(prefix + chunk);
  });
}
child.on('exit', (code) => {
  out.write('[exit] code=' + code + ' at ' + new Date().toISOString() + '\n');
  out.end();
  process.exit(code ?? 0);
});
child.on('error', (e) => {
  out.write('[spawn-error] ' + String((e && e.message) || e) + '\n');
  out.end();
  process.exit(1);
});
