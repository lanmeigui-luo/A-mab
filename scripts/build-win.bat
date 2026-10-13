@echo off
setlocal
cd /d "%~dp0\.."

echo [1/4] 安装依赖
call npm install
if errorlevel 1 exit /b 1

echo [2/4] 构建前端 (npm run build -> dist/)
call npm run build
if errorlevel 1 exit /b 1

echo [3/4] 打包 Python 后端 (dist/backend/tdx-server 与 sidecar-server)
REM 这两个脚本由第二步生成；产物落在 dist/backend/，由 electron-builder extraResources 收集
if exist scripts\build-tdx.bat (
  call scripts\build-tdx.bat
) else (
  echo 跳过 scripts\build-tdx.bat（将在第二步生成）
)
if exist scripts\build-sidecar.bat (
  call scripts\build-sidecar.bat
) else (
  echo 跳过 scripts\build-sidecar.bat（将在第二步生成）
)

echo [4/4] Electron 打包 (electron-builder)
call npm run build:win
if errorlevel 1 exit /b 1

echo 完成。产物位于 dist-electron\
endlocal
