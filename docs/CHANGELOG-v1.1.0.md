# v1.1.0 版本经验（2026-11-26 封版）

基于 v1.0.0（2026-11-19）之后 20 个 commit 的核心改动。仅记录可复用的经验与口径，不重复 commit 全文。

## 1. T+1 结算口径

- `entryTargetDate` 锁定「记录日之后第一个交易日」为唯一盘中触发日；历史回填时该日已过，不会误触发，晚间由日 K 兜底结算。
- `pending` 分钟线消解由 store 启动时扫描 + 结算时内联触发；`applyMinuteResolution` 是已平仓记录的定向例外，必须带 `minuteResolve` 元数据。
- `no_signal` 占位只在该日该战法无任何记录时生成；全量补完后历史日之间保持一致。

## 2. 当日涨跌幅与昨收统一

- **接口优先**：`/api/quote` 的 `changePct` / `prevClose` 是唯一权威；前端禁止用日 K 推导当日涨跌幅。
- 日 K 只在接口缺失时兜底，且必须过两道校验：
  1. 日期新鲜度：只取「日期 < 今天」的最后一根，且等于上一个交易日（跳周末）；**禁止按 `length - 2` 位置取**——盘中日 K 不含当天，按位置会退到前天（sh600814 事故：`6.90` → 真实 `7.59`，`+21.01%` → `+10.01%`）。
  2. 极端偏离：`|bar.close - price| / price > 35%` 弃用（35% 覆盖北交所 30% 上限；不能用 5%，涨停票会被误杀）。
- 三处消费（头部 / 底部统计 / 图表昨收虚线）统一调 `resolveTodayPrevClose`，返回 `null` 时显示「无基准价」，绝不拿现价凑数。
- server 收盘快照同样加日期新鲜度校验：`trading=false` 但日 K 不含当天时改用接口值，无接口则 `changePct=null`。

## 3. 历史快照回填

- 自动范围 = `snapshotDates` 倒序尾部 5 个（快照列表口径，不是自然日回推、不是工作日推算）；更早的缺口走战法胜率页「补全历史快照」手动入口。
- 战法级合并按 `date:strategyId:code` 复用 `existingKeys`；覆盖优先级：仅「待买入 + intraday_late」可被 close 覆盖，持仓 / 已平仓 / 未成交保留本地。
- 手动补全：二次确认展示规模、每批 3 天 `yieldToUI`、可中断、幂等；模块级 `backfillInFlight` 做跨实例互斥，响应式 `inFlight` state 驱动按钮置灰（普通模块变量不触发 re-render）。
- 历史零命中战法同样补 `no_signal`（用户诉求「每天都有交代」；快照只含当时已上线战法）。补完后胜率分母由 9 变为 655，历史胜率数字变化是预期结果。

## 4. 战法线开关

- 数据源限制：`/api/eval` 的 `tradePlan` 是**单个**（`buildTradePlan` 内部 `pickPrimary`），`StrategyHit` 无 `plan` 字段 → 本版只做「显示 / 不显示」开关，不做按战法选择 / 全部显示 / 颜色区分。要做到需后端先给 `strategies[]` 每项独立 plan。
- `showPlan` 状态在 `StockDetail`，默认 `false`、不持久化、切股票不重置；按钮在 toolbar「深度分析」之后，复用 `.btn`，未命中战法置灰 + 提示。
- `KlineChart` 受控（`showPlan` prop），`effectivePlan = showPlan ? plan : null`；分时 / 日 K 两处 y 轴与 planLines 同源，关闭时 plan 完全不参与缩放。

## 5. 热力图动态权重与窄屏降级

- 板块热力图权重自适应：n 口径与相对地板、文字分级相对阈值按实际板块数动态调整。
- 详情头部与 toolbar 四档降级（560 / 440 / 380）：名称优先于代码（代码先 `flex-shrink:2` 压缩再隐藏，名称保底 4em）；星标自 w1 起收为图标；w2 隐藏涨跌额；w3 隐藏代码 + 收起按钮缩 padding。
- **踩坑**：`headClass` 只加在 `<header>` 时，`.dh-w3 .toolbar` 这类后代选择器永不命中（toolbar 是兄弟节点）；修法是 toolbar 也挂 `headClass`，且让位规则写复合选择器 `.toolbar.dh-w3 > ...`。

## 构建与打包（本次）

- 前端构建镜像：`npm_config_registry` / `ELECTRON_MIRROR` / `ELECTRON_BUILDER_BINARIES_MIRROR` 全部指向 npmmirror。
- Python 后端（sidecar / tdx）未重编：本版 20 个 commit 零 `.py` 改动，`sidecar/server.py` mtime 早于 `sidecar-server.exe`；`server/*.mjs` 走 Electron asar，不依赖 `dist/backend`。
- `dist-electron/` 是历史中间目录，`electron-builder.yml` 的 files / extraResources 均未引用，残留旧 `app.asar` 不进包。
- 未签名构建会被 SmartScreen 拦，属预期（本地自用 `win.sign` 指向 noop-sign）。
- 产物仍输出到 `release/`；若 Defender 锁目录，可 CLI 覆盖 `-c.directories.output=release-110` 后单文件拷回。
