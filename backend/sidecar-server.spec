# -*- mode: python ; coding: utf-8 -*-
# AkShare 补充源服务（sidecar-server）单目录(onedir)打包规格
#
# 构建（必须在「项目根目录」执行）：
#   pyinstaller backend/sidecar-server.spec --noconfirm --distpath dist/backend --workpath build/backend
# 产物：dist/backend/sidecar-server/sidecar-server.exe
#
# 说明：
#  - 入口 sidecar/server.py（相对项目根）；pathex 含 tdx/ 与 sidecar/。
#  - console=False：双击不闪黑窗。
#  - ⚠ akshare / efinance / py_mini_racer 是大而“脏”的第三方包：
#    · akshare 的 __init__ 顶层 import 了大量子模块（如 stock_feature.stock_margin_bse），
#      PyInstaller 的 modulefinder 收不全，冻结后 import akshare 会直接 ModuleNotFoundError；
#    · py_mini_racer 带原生 mini_racer.dll，collect_dynamic_libs 在本环境没收进来。
#    因此采用「确定性打包」：把这些包整包用 Tree() 作为【数据文件】原样拷进 bundle
#    （含全部 .py 与 .dll），并从 PYZ 分析里 excludes 掉它们，避免同名冲突；
#    运行时 onedir 在 sys.path 上，Python 直接按文件 import，子模块与 DLL 必然到位。

import os as _os
import importlib.util
from PyInstaller.building.datastruct import Tree

_ROOT = _os.path.dirname(SPECPATH)  # 项目根（backend/ 的上级）
_ENTRY = _os.path.join(_ROOT, 'sidecar', 'server.py')


def _pkg_dir(name):
    """返回已安装第三方包的顶层目录（绝对路径）"""
    try:
        sp = importlib.util.find_spec(name)
    except Exception:
        return None
    if sp and sp.submodule_search_locations:
        return _os.path.abspath(sp.submodule_search_locations[0])
    return None


_BUNDLE_PKGS = {
    'akshare': _pkg_dir('akshare'),
    'efinance': _pkg_dir('efinance'),
    'py_mini_racer': _pkg_dir('py_mini_racer'),
}

a = Analysis(
    [_ENTRY],
    pathex=[_os.path.join(_ROOT, 'tdx'), _os.path.join(_ROOT, 'sidecar')],
    binaries=[],
    datas=[],
    hiddenimports=[
        'pandas', 'numpy', 'requests', 'lxml', 'bs4', 'jsonpath', 'tqdm', 'curl_cffi',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    # 把这些“脏”包从 PYZ 分析里排除，改由下方 Tree() 整包作为数据文件拷贝，
    # 既保证子模块/ DLL 全到，又避免 PYZ 模块与数据文件同名冲突。
    excludes=[
        'tkinter', 'unittest', 'pydoc', 'doctest', 'matplotlib', 'scipy', 'PIL',
        'akshare', 'efinance', 'py_mini_racer',
    ],
)

# 整包作为数据文件拷进 bundle（含全部 .py 与 mini_racer.dll）。
# Tree() 返回 3 元组 TOC (dest, src, 'DATA')，可直接追加。
for pkg, d in _BUNDLE_PKGS.items():
    if d and _os.path.isdir(d):
        a.datas += Tree(d, prefix=pkg)
        print(f"[spec] bundled package {pkg} from {d}")
    else:
        print(f"[spec] WARNING: package {pkg} not found, skipped")

pyz = PYZ(a.pure, a.zipped_data)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='sidecar-server',
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
    name='sidecar-server',
)
