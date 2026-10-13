// Free a TCP port by killing the owning process (Windows). Absolute system paths.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileP = promisify(execFile);
const NETSTAT = 'C:\\Windows\\System32\\netstat.exe';
const TASKKILL = 'C:\\Windows\\System32\\taskkill.exe';
const PORT = process.argv[2] || '8787';

try {
  const { stdout } = await execFileP(NETSTAT, ['-ano', '-p', 'TCP'], { windowsHide: true });
  const lines = stdout.split(/\r?\n/);
  const hit = lines.find((l) => l.includes(':' + PORT + ' ') && (l.includes('LISTENING') || l.includes('ESTABLISHED')));
  if (!hit) {
    console.log('PORT_FREE ' + PORT);
    process.exit(0);
  }
  const pid = hit.trim().split(/\s+/).pop();
  console.log('FOUND pid=' + pid + ' on ' + PORT);
  try {
    await execFileP(TASKKILL, ['/PID', pid, '/F', '/T'], { windowsHide: true });
    console.log('KILLED ' + pid);
  } catch (e) {
    console.log('KILL_FAIL ' + e.message);
  }
} catch (e) {
  console.log('NETSTAT_FAIL ' + e.message);
}
