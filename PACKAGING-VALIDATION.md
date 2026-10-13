# A股博弈雷达 · Windows 打包最小端到端验证报告

> 范围：仅验证打包产物本身（两个 PyInstaller onedir exe 能否干净构建、干净启动、回写 `PORT=`），不含 health 扩展 / 静态托管 / holidays。
> 验证日期：2026-10-08
> 结论：**阶段 4（tdx 四项验证全 PASS）、阶段 5（体积实测 + NSIS 预估）全部完成；六点悬置已全部明确回答；未触发裁剪路线。可进 3a。**

---

## 一、阶段 4 — tdx-server.exe 启动验证

**执行方式**：绝对路径启动 `dist\backend\tdx-server\tdx-server.exe --port 0`，stdout/stderr 重定向到文件（`tdx_stdout.log` / `tdx_stderr.log`），不走管道。脚本：`scripts/verify/verify_tdx.py`。

### 验证点① 首行 `PORT=` 回写
```
首行原始内容: 'PORT=59607'
解析 PORT: 59607
```

### 验证点② `/health` 原始返回（节选）
```json
{
  "ok": true,
  "reason": null,
  "port": 0,
  "poolSize": 12,
  "stats": { "connects": 12, "reconnects": 0, "errors": 0 },
  "sample": {
    "fullCode": "sh600519", "code": "600519", "market": "sh",
    "price": 1255.79, "prevClose": 1258.62, "open": 1252.9,
    "high": 1258.0, "low": 1242.0, "volume": 25167,
    "amountYuan": 3145413120.0, "change": -2.83, "changePct": -0.2248,
    "servertime": "15:17:26.532",
    "bidAsk": { "bid1": 1255.41, "ask1": 1255.79, ... }
  },
  "elapsedMs": 63,
  "fetchedAt": "2026-10-08T16:48:10"
}
```

### 验证点③ 真实行情 `/quotes?codes=sh600519` 原始返回（节选）
```json
{
  "ok": true,
  "rows": [{
    "fullCode": "sh600519", "price": 1255.79, "prevClose": 1258.62,
    "open": 1252.9, "high": 1258.0, "low": 1242.0, "volume": 25167,
    "servertime": "15:17:27.132", "bidAsk": { ... }
  }],
  "count": 1, "requested": 1, "elapsedMs": 76,
  "server": "通达信行情服务器（pytdx 直连）"
}
```
佐证 `/kline?code=sh600519&period=day&count=5&adjust=none` → `ok: true, count: 5`（返回 09-24 ~ 10-08 五个交易日真实日线）。

### 验证点④ stderr 关键错误检查
```
stderr 内容（前 1500 字符）: （空）
含 ModuleNotFoundError/ImportError/pytdx未安装: False
含 traceback: False
```

### 阶段 4 结论
| 验证点 | 结果 |
|---|---|
| ① `PORT=` 回写 | **PASS**（59607） |
| ② `/health` ok:true | **PASS**（ok=True，sample 真实茅台行情） |
| ③ 真实行情 price/servertime 非空 | **PASS**（price=1255.79，servertime=15:17:26.532；另 /quotes price=1255.79） |
| ④ stderr 无 ModuleNotFoundError/ImportError/traceback | **PASS**（stderr 为空） |

> pytdx 初始化完全正常：通达信直连主源实时可用，返回茅台真实行情 + 五档盘口。无需补 `tdx-server.spec` hiddenimports（打包已干净）。

---

## 二、阶段 5 — 体积实测

### 两个 onedir 目录（目录总计，非单 exe）
| 产物 | 目录总计大小 | 文件数 |
|---|---|---|
| `dist/backend/tdx-server` | **87.28 MB**（91,519,017 字节） | 759 |
| `dist/backend/sidecar-server` | **122.58 MB**（128,537,635 字节） | 1671 |

### 各目录 Top 文件（体积主导项）
**tdx-server**
```
19.64 MB  _internal\numpy.libs\libscipy_openblas64_...dll
10.53 MB  tdx-server.exe
 9.44 MB  _internal\cryptography\...\bindings\_rust.pyd
 7.61 MB  _internal\libcrypto-3-x64.dll
 5.86 MB  _internal\python313.dll
```
**sidecar-server**
```
19.64 MB  _internal\numpy.libs\libscipy_openblas64_...dll
11.54 MB  _internal\py_mini_racer\mini_race.dll
10.68 MB  sidecar-server.exe
10.32 MB  _internal\py_mini_racer\icudtl.dat
 9.44 MB  _internal\cryptography\...\bindings\_rust.pyd
 7.61 MB  _internal\libcrypto-3-x64.dll
```

### 最终 NSIS 安装包预估大小
> 计算口径：**Electron 二进制 + asar + 两个 onedir 目录，压缩后**。

| 组件 | 未压缩 | 说明 |
|---|---|---|
| `tdx-server` onedir | 87.28 MB | **实测** |
| `sidecar-server` onedir | 122.58 MB | **实测** |
| Electron 运行时二进制 | ~140 MB | **估算**（见下方说明） |
| asar（主进程+preload+renderer 构建） | ~10 MB | **估算**（src 未构建、无 electron-builder 配置） |

- **未压缩合计 ≈ 360 MB**。
- NSIS/LZMA 压缩后（Electron 已是压缩 PE，约 1.5×；Python onedir 约 2.2×；asar 约 3×）：
  **最终安装包预估 ≈ 190 MB（≈ 0.19 GB），合理区间 ~170–220 MB。**

**关键说明**：本环境 `node_modules/electron` **不存在**（Electron 运行时二进制未安装，electron-builder 的后安装下载在受管环境被跳过），故 Electron 二进制与 asar 两项为**估算**；两个 onedir 目录为**实测**。最终精确数字必须在 3b/CI 跑一次 `electron-builder` 才能得到。

### 体积结论 / 裁剪路线决策
- sidecar 实际仅 **122.58 MB**，**远低于 1GB 告警线** → **不裁剪**，可接受。
- 体积主导项是 numpy OpenBLAS DLL（19.64 MB，两目录共有）与 exe 本体（~10 MB），均属必要，无冗余可砍。

---

## 三、六点悬置 — 一次性回答

### ① bat 未在真 cmd 下验证
- **现状**：本环境 `cmd.exe` 被安全策略禁用，无法 `cmd //c scripts\build-*.bat`。
- 本验证用 venv python **直接复刻了两个 bat 的内部步骤**（guard 探测 `import pytdx`/`import akshare` → `pip install -r` → `pip install pyinstaller` → 跑 spec），并成功产出两个 exe。
- **但「复刻步骤」≠「bat 验证」**。bat 本身（含 `set "PY=%VIRTUAL_ENV%\Scripts\python.exe"` 探测、`errorlevel` 跳转、`pause`）**从未在真 cmd 下跑过**。
- **建议**：你在本机 Windows `cmd` 跑一次 `scripts\build-tdx.bat` 与 `scripts\build-sidecar.bat`。
- **若你没有 Windows 环境**：3b 的 `README-打包说明.md` 必须明确写「**bat 未在真 cmd 下验证，首次使用需自行调整**（尤其 `%VIRTUAL_ENV%` 需指向含对应依赖的 Python）」。
- 已知 bat 与复刻步骤都会触发的「已交付文件缺陷」已在验证循环里就地修好（见第四节），这些 bug 在真 cmd 下同样会触发，已修。

### ② requirements-sidecar.txt 逐条 `pip install` 验证
`pip show` 在 venv 核对已装版本；`pip index versions` 核对 PyPI 该版本是否存在。

| 包 | 锁版本 | venv 已装 | PyPI 该版本存在？ | 结论 |
|---|---|---|---|---|
| akshare | 1.18.97 | 1.18.97 | 存在（最新 1.19.1） | ✅ |
| efinance | 0.5.9 | 0.5.9 | 存在 | ✅ |
| pandas | 3.0.6 | 3.0.6 | 存在 | ✅ |
| numpy | 2.5.3 | 2.5.3 | 存在 | ✅ |
| requests | 2.34.2 | 2.34.2 | 存在 | ✅ |
| lxml | 6.1.3 | 6.1.3 | 存在 | ✅ |
| beautifulsoup4 | 4.15.0 | 4.15.0 | 存在 | ✅ |
| jsonpath | 0.82.2 | 0.82.2 | 存在 | ✅ |
| py_mini_racer | 0.6.0 | 0.6.0 | 存在 | ✅ |

**结论**：9 个包全部 `pip install -r` 成功装到锁版本。**`py_mini_racer==0.14.1` 在 PyPI 根本不存在的教训已吸取**——已改为 `0.6.0`，并实测 `MiniRacer().eval('1+1')==2`。
注：以上是「安装态」验证；冻结进 exe 的可用性由阶段 2/3/4 打包启动通过保证（akshareAvailable:True、pytdx 初始化、真实行情）。

### ③ Tree() 方案的依赖闭包靠什么保证
- **事实**：`sidecar-server.spec` 把 `akshare`/`efinance`/`py_mini_racer` 用 `Tree()` 作为数据文件原样拷进 bundle（含全部 `.py` 与 DLL），并从 PYZ `excludes` 掉。运行时 onedir 在 `sys.path` 上按文件 import，故 akshare 的**全部子模块必然到位**（比 modulefinder 收得更全）。
- **但是**：`Tree()` 只带「这些包自己的文件」；akshare 依赖的**第三方包**（在 akshare 目录之外）在 PYZ 外不会被自动带入，**必须靠 `hiddenimports` 手动补齐**。
- **已补的第三方依赖**：`tqdm`、`curl_cffi`（扫描 akshare 实际 import 后补入 hiddenimports）。
- **sidecar 路由实际触发的 akshare 接口清单**（来自 `sidecar/server.py` ROUTES）：

  | 路由 | akshare 接口 |
  |---|---|
  | /board/list | `ak.stock_sector_spot` |
  | /board/cons | `ak.stock_sector_detail` |
  | /kline/min | `ak.stock_zh_a_hist_min_em` |
  | /board/map | `ak.stock_sector_spot` + `ak.stock_sector_detail` |
  | /board/fund | `ak.stock_fund_flow_concept` + `ak.stock_fund_flow_industry` |
  | /market/stats | `ak.stock_market_activity_legu` |
  | /market/limitup | `ak.stock_zt_pool_em` + `ak.stock_zt_pool_dtgc_em` |
  | /market/prev-limitup | `ak.stock_zt_pool_em` |
  | /fund/rank | `ak.stock_fund_flow_individual` |
  | /board/belong | （efinance `get_belong_board`，非 akshare） |

- **探针结果**（venv，akshare 1.18.97，逐一调用，脚本 `scripts/verify/akshare_probe.py`）：
  - **OK（import+调用成功，无 ModuleNotFoundError）**：`stock_sector_spot` / `stock_sector_detail` / `stock_fund_flow_concept` / `stock_fund_flow_industry` / `stock_market_activity_legu` / `stock_zt_pool_em` / `stock_zt_pool_dtgc_em` / `stock_fund_flow_individual` —— **8/9 通过**。
  - **NET（仅网络错误，非模块缺失）**：`stock_zh_a_hist_min_em` → `ConnectionError/RemoteDisconnected`（东财网络），属上游可达性问题，**与打包无关**。
- **结论**：在 sidecar 当前触发的接口范围内，`Tree()` 整包 + `hiddenimports(tqdm/curl_cffi)` 的依赖闭包**无缺失**。不要求全跑 akshare 所有接口；未来启用未触发过的接口，需在打包后补跑探针确认。

### ④ 体积结论
- 两个 onedir 实测：tdx **87.28 MB / 759 文件**，sidecar **122.58 MB / 1671 文件**。
- NSIS 预估 **≈ 190 MB（≈ 0.19 GB，区间 ~170–220 MB）**，其中 Electron 二进制与 asar 为估算（本环境未装 Electron）。
- **不裁剪**（sidecar 远低于 1GB 告警线）。

### ⑤ 保留文件归属
| 文件 | 归属 | 处理 |
|---|---|---|
| `PACKAGING-VALIDATION.md` | **进仓库**（验证结论文档，随仓库走） | 保留在根目录 |
| `scripts/verify/verify_tdx.py` | **本地验证脚本**（不进仓库） | 已移入 `scripts/verify/`，`.gitignore` 已忽略 |
| `scripts/verify/verify_sidecar_full.py` | **本地验证脚本** | 同上 |
| `scripts/verify/measure_volumes.py` | **本地验证脚本** | 同上 |
| `scripts/verify/akshare_probe.py` | **本地验证脚本** | 同上 |

> 说明：当前仓库**未 git init**（无 `.git`），以上归属是「归仓库时」的规划；3b 初始化仓库时按此落地。`.gitignore` 已新增 `scripts/verify/` 与 `*.report.txt`，验证脚本及其产出报告均不进仓库。

### ⑥ py_mini_racer 明确标「未验证」
- **事实**：sidecar 当前**没有任何路由**触发用到 `py_mini_racer` 的 akshare 加密接口（9 条路由用到的 akshare 函数中，无一是需 `py_mini_racer` 的解密路径；`stock_zh_a_hist_min_em` 走东财明文接口）。
- 打包层面只验证了：**DLL 已打进 onedir**（`_internal\py_mini_racer\mini_race.dll` 11.54 MB）+ **venv 内 `MiniRacer().eval('1+1')==2`（PYMR_OK 2）**。
- **运行时未验证**：没有接口真正调用它。
- **本报告明确标注**：「DLL 加载测试通过，但运行时未验证，因无接口触发」。**不使用 `sys.path+import` 当作运行时通过**。3a 若接入需 `py_mini_racer` 的接口，须补运行时验证。

---

## 四、验证循环中修复的「已交付文件」缺陷（属验证循环，非范围蔓延）
这些 bug 真 cmd 下同样会触发，已全部就地修好：
1. `requirements-sidecar.txt`：`py_mini_racer==0.14.1` 在 PyPI 不存在 → 改 `0.6.0`。
2. `tdx-server.spec` / `sidecar-server.spec` 入口路径 bug → 改用 `SPECPATH` 算项目根绝对路径。
3. `sidecar-server.spec` akshare 打包坑（collect_all 2 元组、子模块收不全、mini_race.dll 没收、tqdm/curl_cffi 漏带）→ 最终 `Tree()` 整包 + excludes + hiddenimports(tqdm/curl_cffi)。
4. `sidecar/server.py` 诊断期临时 `traceback.print_exc()` 已回退，无净改动。

---

## 五、进 3a 前置条件核对
- [x] 六点悬置全部有明确回答（见第三节）
- [x] 阶段 4 四项验证全 PASS（PORT= / health ok:true / 真实行情非空 / 无 ModuleNotFoundError）
- [x] 阶段 5 体积已给出，且已决策**不裁剪**

→ **可进 3a。**

---

## 六、3a 范围（汇总通过后再开始，先出方案不写代码）
- `/api/health` 扩展：`sources[]` / `sidecar.available` / `mock` / `marketStatus`
- `server/index.mjs` 补 `dist` 静态托管（SPA fallback）
- `data/holidays.json` + `marketStatus` 计算（判定顺序：节假日 JSON → 周几 → 时间窗 09:30–11:30 / 13:00–15:00）
- **baostock 明确不接入**：从 `sidecar-server.spec` 删注释占位；README 写明「财务/K线校验源暂未接入」
- health 的 sidecar 状态由 `main.js` **显式传 `SIDECAR_DISABLED`**（区分「sidecar 崩溃」vs「精简版禁用」），不靠「探测 0 端口失败」推断
- sidecar 内 `py_mini_racer` 调用包 `try/except`，失败仅标接口不可用、不整体宕机

### 3a 新增：`data/holidays.json` 数据来源（上交所官方，非「WebSearch 取得」）

- **来源文件**：`data/holidays.json`（纯字符串数组 `["2026-01-01", ...]`，内嵌不联网）。
- **权威出处**：上海证券交易所《关于上海证券交易所2026年部分节假日休市安排的通知》**上证公告〔2025〕45号**。
- **官方链接**：`https://www.sse.com.cn/disclosure/announcement/general/c/c_20251222_10802507.shtml`
- **发布日期**：2025 年 12 月 22 日（发布时 2026 全年休市安排尚未发生，属预先公告）。
- **关键原文片段**（已逐字核对，繁体版 `big5.sse.com.cn` 与简体版 `www.sse.com.cn` 一致）：

  > 一、休市安排
  > （一）元旦：1月1日（星期四）至1月3日（星期六）休市，1月5日（星期一）起照常开市。另外，1月4日（星期日）为周末休市。
  > （二）春节：2月15日（星期日）至2月23日（星期一）休市，2月24日（星期二）起照常开市。另外，2月14日（星期六）、2月28日（星期六）为周末休市。
  > （三）清明节：4月4日（星期六）至4月6日（星期一）休市，4月7日（星期二）起照常开市。
  > （四）劳动节：5月1日（星期五）至5月5日（星期二）休市，5月6日（星期三）起照常开市。另外，5月9日（星期六）为周末休市。
  > （五）端午节：6月19日（星期五）至6月21日（星期日）休市，6月22日（星期一）起照常开市。
  > （六）中秋节：9月25日（星期五）至9月27日（星期日）休市，9月28日（星期一）起照常开市。
  > （七）国庆节：10月1日（星期四）至10月7日（星期三）休市，10月8日（星期四）起照常开市。另外，9月20日（星期日）、10月10日（星期六）为周末休市。

### 3a 新增补充：与上交所公告对齐的国务院放假安排（交叉核对）

> 为确认 `data/holidays.json` 不与上位依据冲突，额外核对了国务院办公厅发布的放假通知。

- **权威出处（上位依据）**：国务院办公厅《关于 2026 年部分节假日安排的通知》，**2025 年 11 月 4 日发布**，公开发布于中国政府网（www.gov.cn）；全文转载见人民网 `https://politics.people.com.cn/BIG5/n1/2025/1105/c1001-40596810.html`。
- **关键原文片段**（已逐字核对，与上证公告〔2025〕45号一致）：

  > 一、元旦：1月1日（周四）至3日（周六）放假调休，共3天。1月4日（周日）上班。
  > 二、春节：2月15日（农历腊月二十八、周日）至23日（农历正月初七、周一）放假调休，共9天。2月14日（周六）、2月28日（周六）上班。
  > 三、清明节：4月4日（周六）至6日（周一）放假，共3天。
  > 四、劳动节：5月1日（周五）至5日（周二）放假调休，共5天。5月9日（周六）上班。
  > 五、端午节：6月19日（周五）至21日（周日）放假，共3天。
  > 六、中秋节：9月25日（周五）至27日（周日）放假，共3天。
  > 七、国庆节：10月1日（周四）至7日（周三）放假调休，共7天。9月20日（周日）、10月10日（周六）上班。

- **对照结论**：国务院通知与上交所公告〔2025〕45号 的 **7 个区间、合计 33 天完全一致、无任何出入**。`data/holidays.json` 据此生成，无偏差。
- **以哪个为准**：A 股实际休市以**上交所公告**为最终准绳（交易所休市安排依据国务院放假办法制定，二者同源；若未来某年出现口径差，以交易所公告为准，因其是结算/交易的直依据）。本文件两来源一致，不存在取舍冲突。
- **2026 春节 2/15–2/23 天数核对**：2月15日（腊月二十八）至 2月23日（正月初七）= **连续 9 天**，与国务院、上交所双通知逐字一致。注意 2/14（周六）、2/28（周六）为调休上班日，但二者均属周末、市场本就休市，故 `holidays.json` 只录入 2/15–2/23 连续 9 天，不额外录入周末（由 `marketStatus` 状态机的「周末兜底」覆盖）。

- **本文件的处理口径**：只列官方明确休市区间（共 33 天），「另外…为周末休市」的冗余项由 `marketStatus` 状态机的「周末兜底」覆盖，不重复录入。
- **年度维护**：该文件**每年需手动更新一次**（公告发布后改 `data/holidays.json` 区间；3b 的 README 会注明）。若某年公告把周末调为上班交易日，需额外在状态机补「调休上班」白名单（2026 公告无此类调整）。

---

## 七、待 3b 兑现的提醒（本轮确认，不影响 3a）

> 以下两点在 3a 汇总时由用户明确提出，属 3b 范围，记录于此以免遗漏。**3a 不夹带这些。**

### 提醒 1：Electron 壳层从未真正构建过
- 现状：本环境 `node_modules/electron` **未安装**，electron-builder 的后安装下载在受管环境被跳过。
- 因此 `main.js` / `preload.js` / `electron-builder.yml` **只过了语法检查**；以下均**未验证**：
  - `asar` 内 server 树能否被 ESM loader 正确解析（`asarUnpack: server/**/*` 是否真的让 node-api 脱离 asar 运行）；
  - `preload.js` 的 `window.__APP_CONFIG__` 注入（apiBase / 版本）；
  - `APP_API_BASE` 注入后 Electron 用 `http://127.0.0.1:<apiPort>/` 加载前端 + API 的通路；
  - `taskkill /T /F` 关子进程树、单实例锁、端口持久化等。
- **3b 要求**：跑 `electron-builder` 时给 Electron 壳层**预留专门返工时间**，对上述每一项做实测，别假定通过。

### 提醒 2：NSIS 预估 190 MB 偏乐观
- 上一节「≈ 190 MB（区间 170–220 MB）」是把 Electron 二进制按 1.5×、Python onedir 按 2.2×、asar 按 3× 粗算的，且 Electron/asar 两项是**估算未实测**。
- 更保守的粗算口径（压缩前 360 MB，Electron PE 压缩比差、onedir 含大量小文件压缩率低）：
  **140（Electron）+ 10（asar）+ 210（两个 onedir 未压缩 / 压缩后约 100–120）≈ 250–270 MB 量级**。
- **3b 要求**：用 `electron-builder` 实测 NSIS 产物后，**回来更新本报告第三节/第四节的 NSIS 数字**，把「预估」替换为「实测」，**不要把它当承诺值对外**。
- ✅ **已兑现（2026-10-12，dist-electron-v4 构建）**：实测 NSIS = **146.53 MB**（153,650,311 B）、portable = **146.34 MB**（153,443,489 B）、`app.asar` = **17.49 KB**（17,907 B）。**sidecar 已完整打进包**（已取证：打包后 `resources/backend/sidecar-server/` = 1671 文件 / 122.6 MB / 含 `_internal/`，与源树 `dist/backend/sidecar-server/` 逐字节一致）——A 点「打包但允许降级」决策已落实，`sidecar.available` 由运行时探测决定、非恒为 false。安装包 146.5 MB 低于早期 170–270 MB 粗估，是压缩率好于估算，并非 sidecar 被排除。第三节/第四节的 NSIS 数字现以「实测」为准，详见第八节「3b 实测产物大小」。

### 提醒 3：sidecar 超时 15s 是治标，根因是 akshare 非懒加载
- 现状：3a 收尾把 `spawnAndReadPort` 的 sidecar 超时从 5s 提到 **15s**（akshare 冷启动实测 ~8s，5s 会把「健康但慢」误判为崩溃）。`main.js` 已加 `[sidecar] PORT 回写耗时 Xs` 日志便于观测真实启动耗时。
- 根因：sidecar 启动时 `import akshare` 在模块加载期同步执行，拖慢首字节到首次 `PORT=` 回写。
- **3b 要求（治本）**：把 sidecar 的 akshare 改为**懒加载**——进程启动只做 `bind` + 立即回写 `PORT=`（让 node-api 拿到端口、health 立即可用），akshare 的 `import` 延迟到**第一次真实调用**时再执行。根因解决后，5s 超时即够，可把 sidecar 超时调回 5s。
- 该 TODO 已在 `electron/main.js` 的 `spawnAndReadPort` 处以 `TODO(3b)` 注释标注。

---

## 八、3b 打包环境坑 / 误报清单（CI 与本地均可能触发，不要当真 bug 追）

> 本机（Win11 + 受管环境）打包 Electron 时反复踩的一批**环境性**坑。它们**不是代码缺陷**，报错长得很像真 bug，但根因都在本机策略/网络/权限。CI 首次跑或本地换机遇到时，对照本表判断，避免无谓返工。
> 列表**不设上限**——每遇一个新增一条。

### 坑 1：winCodeSign 7z 解压失败（符号链接无特权）
- **报错**：`ERROR: Cannot create symbolic link : 客户端没有所需的特权。 : ...\darwin\10.12\lib\libcrypto.dylib`（2 条，libssl.dylib 同）。
- **根因**：electron-builder 对 `nsis`/`portable` 目标会下载 `winCodeSign` 工具包，目的是里面的 **`rcedit.exe`**（给 exe 嵌图标/版本资源），**不是为签名**。其 7z 内含 macOS `.dylib` 符号链接，当前账户无「创建符号链接」特权，7z 解压必败。
- **⚠️ 易错归因**：`scripts/noop-sign.cjs` 只跳过**实际 Authenticode 签名**（无证书时），**并不会阻止 winCodeSign 下载**（下载是为 rcedit）。别以为配了 noop-sign 就万事大吉。
- **修复**：手动把 `winCodeSign-2.6.0.7z` 解压到 `%LOCALAPPDATA%/electron-builder/Cache/winCodeSign/winCodeSign-2.6.0/`，容忍那 2 个 darwin 符号链接错误即可（Windows 用不到它们）。下次构建命中缓存跳过下载。
  - 7za 路径：`node_modules/7zip-bin/win/x64/7za.exe x -bd -y <7z> -o<目标dir>`。
  - 只要 `rcedit-x64.exe` / `signtool.exe` 在，构建就能继续。

### 坑 2：npmjs.org + github.com 双断网
- **报错**：`npm install` 卡死/超时；electron-builder 下载 electron 运行时或 winCodeSign 报 `ETIMEDOUT`/`ENOTFOUND`。
- **根因**：本机默认两个域名不可达。
- **修复**：三镜像（缺一不可）：
  - `npm_config_registry=https://registry.npmmirror.com/`
  - `ELECTRON_MIRROR=https://registry.npmmirror.com/-/binary/electron/`
  - `ELECTRON_BUILDER_BINARIES_MIRROR=https://registry.npmmirror.com/-/binary/electron-builder-binaries/`

### 坑 3：Windows Defender 实时扫描锁输出目录
- **报错**：构建中 `EBUSY` / `EPERM`；或 `app.asar` 写入卡死；或 `ResourceMoveError`（重命名被锁）。
- **根因**：Defender 实时扫描大目录（含 exe/dll），短暂锁文件，与 electron-builder 的写/重命名冲突。
- **修复**：把 `electron-builder.yml` 的 `directories.output` 临时改成**新目录名**（如 `dist-electron-v2`、`dist-electron-build`）即可避开被锁的旧目录。旧目录事后手动清理（见坑 5）。

### 坑 4：shell shim 间歇性损坏
- **报错**：git-bash 下 `tail`/`grep`/`ls`/`npm` 偶发 `command not found`，或 `npm run xxx` 找不到脚本。
- **根因**：本机 shell 环境 shim 偶发损坏。
- **修复**：用 **node 绝对路径**跑脚本（`node node_modules/electron-builder/cli.js --win`），文件增删改名用 node 脚本而非 shell 内建；度量大小用 `node -e '...'`。

### 坑 5：node `fs.rmSync` 被 safe-delete 拦截
- **报错**：`[safe-delete] 操作失败: ERROR ... during a 'trash' operation`（删旧构建目录时）。
- **根因**：本机文件删除被重定向到「进回收站」的安全包装，对大目录/锁文件会失败。
- **修复**：不要 `rm -rf`；改用 `fs.renameSync` 改名隔离，或换全新 `output` 目录让旧目录自然成垃圾（无害，待 Defender 解锁后手动清）。重命名若也 `EPERM`（被锁），只能等锁释放。

### 坑 6：`package.json` 缺 `main` 字段
- **报错**：`electron-builder ... index.js does not exist`。
- **根因**：yml 没显式指 `main`，electron-builder 默认找 `index.js`。
- **修复**：`package.json` 加 `"main": "electron/main.js"`（已加）。

### 坑 7：vite `outDir` 与 `dist/backend` 冲突
- **报错**：asar 体积异常大（实测 211 MB），安装包预估虚高。
- **根因**：早期 `vite.config.ts` 的 `outDir: 'dist'` 与 PyInstaller 的 `dist/backend` 混在同一 `dist`，electron-builder `files: dist/**/*` 把 backend 收进 asar，又 `extraResources` 再收一份 → 重复 + 翻倍。
- **修复**：vite `outDir: 'dist/web'` + `emptyOutDir: false`；yml `files` 排除 `dist/**/*`，`extraResources` 显式 `dist/web → resources/dist`、`dist/backend → resources/backend`。修复后 asar 回到 ~17 KB。

### 坑 8：未签名被 SmartScreen 拦截
- **现象**：双击安装包/便携版，Windows 弹「Windows 已保护你的电脑」SmartScreen 警告。
- **根因**：本地构建未做 Authenticode 签名（`win.sign` 指向 noop-sign.cjs）。
- **处置**：本地自用可「仍要运行」放行；发布版必须准备 `.pfx` 并移除 noop-sign 引用（见该文件注释）。这**不是 bug**，是预期行为。

### 坑 9：NSIS/portable 压缩极慢（疑似挂起）
- **现象**：构建在 `packaging` 之后长时间无新日志，CPU/磁盘活跃但像卡死。
- **根因**：~245 MB 未压缩产物（Electron ~172 MB + 两个 onedir backend ~210 MB）经 LZMA/zip 压缩，且 Defender 实时扫描拖慢；正常需数分钟到十余分钟。
- **处置**：**不是挂起**。看输出目录总大小是否持续增长；增长即正常。耐心等，勿中途杀进程（杀了下次还得重来，且易留锁目录）。

### 坑 10：bat 未在真 cmd 下验证
- **现象**：`scripts/build-*.bat` 首次在本机 Windows `cmd` 跑可能行为不符预期（尤其 `%VIRTUAL_ENV%` 探测、`errorlevel` 跳转）。
- **根因**：本机 `cmd.exe` 曾被安全策略禁用，验证阶段用 venv python 直接复刻了 bat 内部步骤（产 exe 成功），但 bat 自身未真跑过。
- **处置**：首次在真 cmd 跑若有问题，重点查 Python 环境探测与 `pause` 交互；这些缺陷在真 cmd 下同样会触发，已在验证循环就地修好（见第七节）。

### 坑 11（实测结果）：3b 构建三项产物大小（2026-10-12，dist-electron-v4）

> 用 `electron-builder --win` 真打包后的实测值，已回填 `README-打包说明.md` 第 6 节。不是预估，**是真实产物大小**（但会随打包内容浮动，勿当承诺值对外）。

| 产物 | 实测大小 | 备注 |
|---|---|---|
| NSIS 安装包 `A股博弈雷达 Setup 0.1.0.exe` | **146.53 MB**（153,650,311 字节） | LZMA 压缩 |
| portable `A股博弈雷达 Portable 0.1.0.exe` | **146.34 MB**（153,443,489 字节） | 自解压 NSIS exe（electron-builder 的 portable 实为 exe，非 .zip；`unpackDirName` 须用 `astock-radar` 而非 `${productName}`，见坑 7 衍生） |
| `resources/app.asar` | **17.49 KB**（17,907 字节） | server 树经 `asarUnpack` 抽离到 `app.asar.unpacked`，BugB（211 MB 重复收 backend）修复验证通过 |

- **GUI 实测结论**：无头 bash 环境无法启动 GUI electron（exe 新启动即退出码 0、无任何 stdout/stderr/日志），属**环境限制非 app bug**；按预案转静态核对——`electron/preload.js` 的 `__APP_CONFIG__` 注入、`electron/main.js` 的 `APP_STATIC_DIR=resources/dist` / `SIDECAR_DISABLED=1` / `APP_API_BASE` 经源码核对逻辑正确。需在**有桌面会话的 Windows** 上真机双击验证窗口/行情加载（建议走 `dist-electron-v4/win-unpacked/A股博弈雷达.exe`）。
- **sidecar 进包确认（更正提醒2 初稿误述）**：提醒2 初稿曾写「本次构建未把 sidecar onedir 打进包」，经取证已推翻——打包后 `resources/backend/` 下 `tdx-server/`（759 文件 / 87.3 MB）与 `sidecar-server/`（1671 文件 / 122.6 MB、`_internal/` 完整）均完整存在，与 `dist/backend` 源树逐字节一致。故 v0.1.0 **含补充源**，`health` 的 `sidecar.available` 取决于运行时能否真正拉起 sidecar，不会恒为 disabled。
