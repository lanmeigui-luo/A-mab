# -*- mode: python ; coding: utf-8 -*-
# 通达信主源服务（tdx-server）单目录(onedir)打包规格
#
# 构建（必须在「项目根目录」执行，避免产物跑到 backend/dist）：
#   pyinstaller backend/tdx-server.spec --noconfirm --distpath dist/backend --workpath build/backend
# 产物：dist/backend/tdx-server/tdx-server.exe
#
# 说明：
#  - 入口为 tdx/server.py（相对项目根）；pathex 含 tdx/ 与 sidecar/。
#  - console=False：双击不闪黑窗。
#  - 端口由运行时 --port / 环境变量 / 默认 决定，并回写 stdout 的 PORT=<port>，不硬编码。
#  - 仅含 pytdx（通达信主源所需），不含 akshare/efinance，保持精简。

import os as _os
_ROOT = _os.path.dirname(SPECPATH)  # 项目根（backend/ 的上级）；SPECPATH 为 PyInstaller 注入的 spec 所在目录
a = Analysis(
    [_os.path.join(_ROOT, 'tdx', 'server.py')],
    pathex=[_os.path.join(_ROOT, 'tdx'), _os.path.join(_ROOT, 'sidecar')],
    binaries=[],
    datas=[],
    hiddenimports=[
        'pytdx',
        'pytdx.hq',
        'pytdx.reader',
        'pytdx.exhq',
        'pytdx.pool',
        'pytdx.util',
        'pytdx.version',
        'pytdx.tools',
        'pytdx.tools.holiday',
        'pytdx.tools.bestip',
        'pandas',
        'numpy',
        'requests',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=['tkinter', 'unittest', 'pydoc', 'doctest', 'matplotlib', 'scipy', 'PIL', 'akshare', 'efinance'],
)

# 收集 pytdx 可能内置的数据文件（服务器列表等）
try:
    from PyInstaller.utils.hooks import collect_data_files
    a.datas += collect_data_files('pytdx')
except Exception:
    pass

pyz = PYZ(a.pure, a.zipped_data)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='tdx-server',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name='tdx-server',
)
