@echo off
setlocal
REM =====================================================================
REM  sidecar-server.exe 构建脚本（PyInstaller onedir / console=False）
REM  用法：在「项目根目录」执行  scripts\build-sidecar.bat
REM  前置：一个「含 akshare」的 Python（项目 venv），先 activate 再运行。
REM        注意：akshare 会拉动极多依赖，首次安装/打包耗时较长，体积大。
REM =====================================================================

cd /d "%~dp0\.." || (echo [build-sidecar] 无法进入项目根目录 & if not defined CI pause & exit /b 1)
echo [build-sidecar] 项目根: %CD%

REM 探测含 akshare 的 Python：优先 VIRTUAL_ENV，否则 PATH 上的 python
set "PY=%VIRTUAL_ENV%\Scripts\python.exe"
if not exist "%PY%" set "PY=python"

echo [build-sidecar] 使用 Python: %PY%
"%PY%" -m pip install -r backend\requirements-sidecar.txt || goto :fail
"%PY%" -m pip show pyinstaller >nul 2>nul || "%PY%" -m pip install pyinstaller
if errorlevel 1 goto :fail

"%PY%" -c "import akshare" >nul 2>nul || (
  echo [build-sidecar] 依赖安装后仍无法导入 akshare，请检查 backend\requirements-sidecar.txt
  goto :fail
)

REM 必须从项目根执行；--distpath 把产物定向到 dist/backend（避免跑到 backend/dist）
"%PY%" -m PyInstaller backend\sidecar-server.spec --noconfirm --distpath dist\backend --workpath build\backend
if errorlevel 1 goto :fail

echo [build-sidecar] 完成：dist\backend\sidecar-server\sidecar-server.exe
goto :end

:fail
echo [build-sidecar] 构建失败，请查看上方输出。
if not defined CI pause
exit /b 1

:end
endlocal
