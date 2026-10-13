# A股博弈雷达 · Windows 打包说明

> 适用：在 Windows 10/11 上把「A股博弈雷达」打包成本地可分发安装包（NSIS）与便携版（portable）。
> 范围：仅打包流程。功能、数据来源、UI 语义见 `PACKAGING-VALIDATION.md` 与代码。
> 最后实测：2026-10-12（3b 构建），electron 31.7.7 + electron-builder 24.13.3，最后一次成功构建归档在 `dist-electron-v4/`（请勿删除，是可分发的安装包/便携版来源）。`directories.output` 已还原为 `dist-electron/`，下次 `build:win` 重新生成到该目录。

---

## 1. 架构与产物总览

打包对象是一个 **Electron 壳 + 内置 Node 服务 + 两个 Python 后端 exe** 的三进程应用：

| 组件 | 来源 | 落点（打包后） |
|---|---|---|
| Electron 主进程壳 | `electron/main.js` + `electron/preload.js` | `resources/app.asar`（仅 ~17 KB，server 树经 `asarUnpack` 抽离到 `app.asar.unpacked`） |
| 前端（React/Vite） | `src/` → `vite build` → `dist/web` | `resources/dist`（extraResources，由 node-api 静态托管） |
| tdx-server（主源，必起） | `backend/tdx-server` → PyInstaller | `resources/backend/tdx-server/tdx-server.exe` |
| sidecar-server（补充源，best-effort） | `backend/sidecar-server` → PyInstaller | `resources/backend/sidecar-server/sidecar-server.exe` |

> **关键分离**：`dist/web`（前端）与 `dist/backend`（Python exe）从源头分离。`electron-builder.yml` 的 `files` 只收主进程代码，`extraResources` 把 `dist/web → resources/dist`、`dist/backend → resources/backend`。**二者绝不能重叠收进 asar**，否则安装包体积翻倍（实测 asar 曾达 211 MB，几乎全是重复收的 backend）。

---

## 2. 环境要求

- Windows 10 1909+ / 11（x64）。
- Node.js（项目用 22.x 受管运行时；本地需 18+）。
- Python 3.13（含 `pytdx` 的 venv 或系统解释器；sidecar 还需 `akshare`/`efinance`）。
- 能访问 npm 镜像与 electron 二进制镜像（见第 3 节；**默认 npmjs.org 与 github.com 在本机被墙**）。
- **不需要代码签名证书**（本地/个人分发；见第 7 节 `winCodeSign` 坑）。

---

## 3. 依赖安装（三镜像绕过双断网）

本机 `npmjs.org` 与 `github.com` 均不可达，electron-builder 下载 electron 运行时、winCodeSign 等会失败。用国内镜像：

```bash
# 方式 A：本次命令内联（推荐，不污染全局 .npmrc）
export npm_config_registry=https://registry.npmmirror.com/
export ELECTRON_MIRROR=https://registry.npmmirror.com/-/binary/electron/
export ELECTRON_BUILDER_BINARIES_MIRROR=https://registry.npmmirror.com/-/binary/electron-builder-binaries/

npm install
```

```bash
# 方式 B：写进项目根 .npmrc（团队共享时）
# registry=https://registry.npmmirror.com/
# electron_mirror=https://registry.npmmirror.com/-/binary/electron/
# electron_builder_binaries_mirror=https://registry.npmmirror.com/-/binary/electron-builder-binaries/
```

> 三镜像是**必要**的：缺一不可。`ELECTRON_MIRROR` 管 electron 运行时下载，`ELECTRON_BUILDER_BINARIES_MIRROR` 管 winCodeSign 等构建工具（见第 7 节）。

---

## 4. 完整打包步骤

### 4.1 构建两个 Python 后端 exe（PyInstaller onedir）

```bash
# tdx 主源（必装 pytdx）
scripts\build-tdx.bat
# sidecar 补充源（需 akshare/efinance；可跳过 → 精简版，见第 5 节）
scripts\build-sidecar.bat
```

- 产物：`dist/backend/tdx-server/tdx-server.exe`、`dist/backend/sidecar-server/sidecar-server.exe`。
- `build-tdx.bat` 先探测 `VIRTUAL_ENV` 或 PATH 上的 python 是否含 `pytdx`，再 `pip install -r backend/requirements-tdx.txt` → `PyInstaller backend/tdx-server.spec`。
- **bat 未在真 cmd 下验证过**（本机 cmd 被安全策略禁用，验证阶段用 venv python 直接复刻了 bat 内部步骤并成功产 exe）。首次在本机 Windows `cmd` 跑若有问题，重点查 `%VIRTUAL_ENV%` 是否指向含对应依赖的 Python 环境。

### 4.2 构建前端

```bash
npm run build      # vite build → dist/web（见 vite.config.ts：outDir=dist/web, emptyOutDir=false）
```

- `emptyOutDir:false` 是有意保留：`dist/backend` 下的 Python exe 不能被 vite 清空。`dist/web` 与 `dist/backend` 独立。
- 必须**先**跑 4.1 再跑 4.2（或顺序无所谓，但 4.3 前两者都要齐）。

### 4.3 Electron 打包

```bash
# 推荐：内联三镜像 + 关闭证书自动发现（避免 electron-builder 去抓不存在的签名）
export npm_config_registry=https://registry.npmmirror.com/
export ELECTRON_MIRROR=https://registry.npmmirror.com/-/binary/electron/
export ELECTRON_BUILDER_BINARIES_MIRROR=https://registry.npmmirror.com/-/binary/electron-builder-binaries/
export CSC_IDENTITY_AUTO_DISCOVERY=false

npm run build:win     # = electron-builder --win
```

- 一键脚本：`scripts/build-win.bat`（依次 install → build → build-tdx/sidecar → build:win）。
- 产物（默认 `directories.output`，当前为 `dist-electron/`）：
  - `dist-electron/A股博弈雷达 Setup x.x.x.exe` —— NSIS 安装版（桌面/开始菜单/卸载）。
  - `dist-electron/A股博弈雷达 Portable x.x.x.exe` —— 便携版（单目录解压即用，数据重定向到 exe 同目录 `data/`）。
  - `dist-electron/win-unpacked/` —— 解压后的完整目录（可直接双击 `A股博弈雷达.exe` 运行，用于冒烟测试）。
  - （注：3b 最后一次成功构建留在 `dist-electron-v4/` 作分发归档，勿删。）

---

## 5. 精简版（跳过 sidecar）

若不需要 akshare/efinance 补充源，用精简版开关只打 tdx：

- `build-win.bat` 支持跳过 sidecar 构建（环境变量/参数控制），则 `dist/backend` 下不含 `sidecar-server` 目录。
- 运行时 `electron/main.js` 的 `resolveService` 探测不到 `sidecar-server.exe` → 自动置 `SIDECAR_DISABLED=1`，前端标「补充源禁用」横幅，**不阻塞主窗口**。
- 详见 `electron/main.js` 注释（区分「精简版禁用」vs「sidecar 进程崩溃」的逻辑）。

---

## 6. 验收清单（每个版本都该跑一遍）

| 项 | 方法 | 通过标准 |
|---|---|---|
| 打包能跑通 | `npm run build:win` 退出码 0，产出 Setup + Portable | 两个 exe 均生成 |
| 主进程壳能起 | 双击 `win-unpacked/A股博弈雷达.exe` | 窗口出现，不弹「启动失败」 |
| 主源 tdx 回写端口 | 看 `userData/logs/tdx.log` 首行 `PORT=` | 5s 内回写 |
| 前端经 node-api 加载 | 窗口显示行情页（非空白） | `__APP_CONFIG__.apiBase = http://127.0.0.1:<port>/` |
| 健康检查 | `userData/logs/main.log` 含 `[health] OK` | 30s 内 OK |
| 三项大小记录 | 见下方，回填 `PACKAGING-VALIDATION.md` | NSIS / portable / asar 实测值已记录 |

**三项产物大小（实测回填，勿当承诺值对外）**：

| 产物 | 大小 | 备注 |
|---|---|---|
| NSIS 安装包 `A股博弈雷达 Setup x.x.x.exe` | **146.53 MB**（153,650,311 字节） | LZMA 压缩；`dist-electron-v4` 实测 |
| portable `A股博弈雷达 Portable x.x.x.exe` | **146.34 MB**（153,443,489 字节） | 自解压 NSIS exe（electron-builder portable 实为 exe 非 .zip）；`dist-electron-v4` 实测 |
| `resources/app.asar` | **17.49 KB**（17,907 字节） | server 树已 `asarUnpack` 抽离，asar 仅含主进程+preload；BugB 修复验证通过 |

> 早期（未分离 dist/web 时）asar 曾达 **211 MB**、安装包预估虚高（BugB）。修复分离后 asar 回到 17.49 KB。**实测安装包 ~146.5 MB**（LZMA 压缩），远低于早期 200–270 MB 估计。该数字随打包内容（是否含 sidecar onedir、Electron 版本等）浮动，每次跑完以真实数字替换本表与 `PACKAGING-VALIDATION.md`。

---

## 7. 已知环境坑（误报清单 / 必读）

这些都不是代码 bug，是**本机环境特性**，CI 或本地构建遇到时**不要当成新 bug 追**。完整清单见 `PACKAGING-VALIDATION.md` 第八节。高频几条：

1. **`winCodeSign` 解压失败（符号链接特权）**：electron-builder 下载 `winCodeSign` 是为了里面的 `rcedit.exe`（给 exe 嵌图标/版本），**不是为签名**（签名已由 `scripts/noop-sign.cjs` 跳过）。其 7z 含 macOS `.dylib` 符号链接，当前账户无「创建符号链接」特权 → 7z 解压报错 `客户端没有所需的特权`。
   **修复**：手动把 `winCodeSign-2.6.0.7z` 解压到 `%LOCALAPPDATA%/electron-builder/Cache/winCodeSign/winCodeSign-2.6.0/`（容忍那 2 个 darwin 符号链接错误即可，Windows 用不到）。下次构建命中缓存跳过下载。
2. **Windows Defender 实时扫描锁住输出目录**：构建中 Defender 扫描大目录会锁 `app.asar` 等文件，导致 `EBUSY`/`EPERM` 或构建卡住。
   **绕过**：把 `electron-builder.yml` 的 `directories.output` 临时改成新目录名（如 `dist-electron-v2`）即可避开被锁的旧目录。
3. **shell shim 间歇性损坏**：本机 git-bash 的 `tail`/`grep`/`ls`/`npm` 偶尔报 `command not found`。
   **绕过**：用 node 绝对路径跑脚本（`node node_modules/electron-builder/cli.js --win`），文件操作用 node 脚本而非 shell 内建。
4. **`npmjs.org` + `github.com` 双断网**：见第 3 节三镜像。
5. **`package.json` 缺 `main` 字段**：electron-builder 报 `index.js does not exist`。已补 `"main": "electron/main.js"`。
6. **未签名**：安装包/便携版**无 Authenticode 签名**，Windows SmartScreen 会拦截/警告。本地自用可接受；发布版需准备 `.pfx` 并移除 `noop-sign.cjs` 引用（见该文件注释）。

---

## 8. 发布前待办（非阻塞）

- [ ] 替换 `build/icon.ico` 占位图标（当前为 electron 默认图标）。
- [ ] 接真实 Authenticode 签名（准备 `.pfx`，设 `CSC_LINK`/`CSC_KEY_PASSWORD`，移除 `win.sign` 的 noop 引用）。
- [ ] **sidecar 的 akshare 改为懒加载**（根因）：启动只 `bind`+回写 `PORT=`，`import akshare` 延迟到首次调用；根因解决后 sidecar 超时 5s 即可（当前为 15s 治标）。`electron/main.js` 有 `TODO(3b)` 标注。
- [ ] `data/holidays.json` 每年手动更新一次（国务院/上交所休市公告）。
- [x] 回填第 6 节三项真实大小到 `PACKAGING-VALIDATION.md`（见第八节「3b 实测产物大小」）。
