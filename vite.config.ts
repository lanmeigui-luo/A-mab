import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

// 同源代理：前端只访问 /api/*，行情请求由本地 Node 服务发出，规避跨域与浏览器直连公开接口。
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
      '/pydata': {
        target: 'http://127.0.0.1:8788',
        changeOrigin: true,
      },
    },
  },
  build: {
    // web 产物输出到 dist/web，与 dist/backend（PyInstaller 的 Python 后端 exe）从源头分离：
    // 避免 electron-builder 的 files:dist/**/* 与 extraResources:dist/backend 重复收录同一份后端，
    // 导致安装包体积翻倍（实测 asar 211MB 几乎全是 dist/backend）。
    outDir: 'dist/web',
    // 不清空 outDir：dist/backend 下是 PyInstaller 产物，手动 rm -rf dist 才会清掉；
    // vite 只写 dist/web，不影响 dist/backend。
    emptyOutDir: false,
    sourcemap: true,
  },
});
