// electron/preload.js
// 最小暴露：注入 window.__APP_CONFIG__，仅暴露前端真正需要的字段与 bridge。
// contextIsolation:true / nodeIntegration:false 下，前端无法直接 require electron。
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('__APP_CONFIG__', {
  // 与页面同源；前端默认仍走相对 /api，apiBase 仅作可覆盖项
  apiBase: process.env.APP_API_BASE || 'http://127.0.0.1:8787',
  appVersion: process.env.APP_VERSION || '0.1.0',
  isDesktop: true,
  bridge: {
    openLogDir: () => ipcRenderer.invoke('app:open-log-dir'),
    copyDiag: () => ipcRenderer.invoke('app:copy-diagnostic'),
    retry: () => ipcRenderer.invoke('app:retry'),
    quit: () => ipcRenderer.invoke('app:quit'),
  },
});
