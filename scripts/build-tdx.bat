@echo off
setlocal
REM =====================================================================
REM  tdx-server.exe 构建脚本（PyInstaller onedir / console=False）
REM  用法：在「项目根目录」执行  scripts\build-tdx.bat
REM  前置：一个「含 pytdx」的 Python（系统 3.13.12 或任何已装 pytdx 的解释器）
REM        推荐：先 activate，或将含 pytdx 的 python 放到 PATH。
REM =====================================================================

cd /d "%~dp0\.." || (echo [build-tdx] 无法进入项目根目录 & if not defined CI pause & exit /b 1)
echo [build-tdx] 项目根: %CD%

REM 探测含 pytdx 的 Python：优先 VIRTUAL_ENV，否则 PATH 上的 python
set "PY=%VIRTUAL_ENV%\Scripts\python.exe"
if not exist "%PY%" set "PY=python"
"%PY%" -c "import pytdx" >nul 2>nul || (
  echo [build-tdx] %PY% 未包含 pytdx。请在含 pytdx 的 Python 环境下运行本脚本。
  echo           （activate venv，或确保 PATH 的 python 已装 pytdx）
  goto :fail
)

echo [build-tdx] 使用 Python: %PY%
"%PY%" -m pip install -r backend\requirements-tdx.txt || goto :fail
"%PY%" -m pip show pyinstaller >nul 2>nul || "%PY%" -m pip install pyinstaller
if errorlevel 1 goto :fail

REM 必须从项目根执行；--distpath 把产物定向到 dist/backend（避免跑到 backend/dist）
"%PY%" -m PyInstaller backend\tdx-server.spec --noconfirm --distpath dist\backend --workpath build\backend
if errorlevel 1 goto :fail

echo [build-tdx] 完成：dist\backend\tdx-server\tdx-server.exe
goto :end

:fail
echo [build-tdx] 构建失败，请查看上方输出。
if not defined CI pause
exit /b 1

:end
endlocal
