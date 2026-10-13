"""
通达信直连行情服务（Python，端口 8789）

为什么要有这个服务：
  WorkBuddy 的「通达信 MCP」工具只在会话内有效，常驻的 Node 服务拿不到。
  本服务用 pytdx（纯 Python 实现的通达信行情协议客户端）**直连通达信行情服务器**，
  不依赖任何会话、不依赖 OAuth，因此 Node 侧可以把通达信当真正的**主数据源**。

实测结论（决定实现方式）：
  1. 公共服务器大量不可用；可用的是国泰君安 117.34.114.x:7709 一组（扫描 104 台得 8 台）
  2. **单次查询只允许 1 个标的**（n=2 即 TdxFunctionCallError）→ 必须多连接并发
  3. K 线全周期真实生效：日=9 周=5 月=6 1分=8 5分=0 15分=1 30分=2 60分=3
  4. 市场：沪=1 深=0（含创业板）北交所=2；北证50 可用，430xxx 部分不支持
  5. 比腾讯源多出：五档盘口（bid/ask 1-5 + 量）、除权除息（可自算复权）

设计原则（与项目一致）：
  - 只转发真实返回，不做补值或模拟
  - 失败返回 ok=false + reason，由 Node 侧降级到腾讯/新浪
  - 慢操作走缓存
"""

import json
import os
import sys
import threading
import time
import queue
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

try:
    from pytdx.hq import TdxHq_API
except ImportError:
    print("pytdx 未安装，请先 pip install pytdx", file=sys.stderr)
    sys.exit(1)

PORT = int(os.environ.get("TDX_PORT", "8789"))

# 实测可用（2026-09-30 扫描 104 台公共服务器得出）
HOSTS = [
    ("117.34.114.16", 7709),
    ("117.34.114.18", 7709),
    ("117.34.114.13", 7709),
    ("117.34.114.17", 7709),
    ("117.34.114.27", 7709),
    ("117.34.114.14", 7709),
    ("117.34.114.15", 7709),
    ("117.34.114.20", 7709),
]

# 周期映射：对外用 Node 侧的周期名，内部是 pytdx category
PERIOD_MAP = {
    "day": 9, "week": 5, "month": 6,
    "m1": 8, "m5": 0, "m15": 1, "m30": 2, "m60": 3,
}

# 市场前缀 → pytdx market
MARKET_MAP = {"sh": 1, "sz": 0, "bj": 2}


def split_code(full):
    """sh600519 → (1, '600519')"""
    if len(full) >= 2 and full[:2] in MARKET_MAP:
        return MARKET_MAP[full[:2]], full[2:]
    # 无前缀时按代码推断
    c = full[-6:]
    if c.startswith(("6", "9")):
        return 1, c
    if c.startswith(("4", "8")):
        return 2, c
    return 0, c


# ---------- 连接池 ----------

class TdxPool:
    """
    每个连接只能串行查 1 个标的，所以并发靠「多连接 + 多线程」。
    连接坏了自动重连并换服务器。
    """

    def __init__(self, hosts, size=8):
        self.hosts = hosts
        self.size = size
        self._q = queue.Queue()
        self._lock = threading.Lock()
        self.stats = {"connects": 0, "reconnects": 0, "errors": 0}
        for i in range(size):
            host = hosts[i % len(hosts)]
            api = self._connect(host)
            if api:
                self._q.put((api, host))

    def _connect(self, host, timeout=4):
        # heartbeat=True 是必需的：通达信公共服务器会主动断开长时间无数据的连接，
        # 池化长连接一旦被踢，调用就会抛 TdxFunctionCallError 且看起来"服务器挂了"
        # （实际单独新建连接完全正常）。心跳线程维持连接活性。
        api = TdxHq_API(raise_exception=True, heartbeat=True)
        try:
            api.connect(host[0], host[1], time_out=timeout)
            with self._lock:
                self.stats["connects"] += 1
            return api
        except Exception:
            try:
                api.disconnect()
            except Exception:
                pass
            return None

    def acquire(self, timeout=5):
        try:
            item = self._q.get(timeout=timeout)
        except queue.Empty:
            # 池空：临时新建一个连接
            for host in self.hosts:
                api = self._connect(host)
                if api:
                    return (api, host)
            return None
        return item

    def release(self, item, broken=False):
        api, host = item
        if broken:
            try:
                api.disconnect()
            except Exception:
                pass
            new = None
            for h in self.hosts:
                new = self._connect(h)
                if new:
                    host = h
                    break
            if new:
                with self._lock:
                    self.stats["reconnects"] += 1
                self._q.put((new, host))
            return
        self._q.put((api, host))

    def _fresh(self):
        """直接新建一个连接（绕过池）"""
        for host in self.hosts:
            api = self._connect(host)
            if api:
                return (api, host)
        return None

    def call(self, fn, retries=3):
        """
        执行 fn(api)，失败自动换连接重试。

        三个必须注意的点：
        1. 归还必须放在 finally —— 曾经写成 try/except/else，而 try 块里的 return
           会跳过 else，导致连接只借不还、池被耗尽（表现为耗时卡在 acquire 超时的 5 秒）。
        2. 必须重试 —— 通达信公共服务器会偶发 TdxFunctionCallError（收盘后/限流时更明显），
           一次失败就判定主源不可用会让整条链路频繁降级到腾讯，失去主源意义。
        3. 重试必须**新建连接**而不是再从池里取 —— 池里的连接会被服务器整批踢掉
           （表现为 health 每次都失败、errors 稳定 +N），此时从池里再取大概率还是坏的，
           只有新建才能恢复。实测新建连接后立即调用 100% 成功；诊断过
           raise_exception × heartbeat × 多线程四种组合，pytdx 本身没有问题。
        """
        last_err = "无可用通达信连接"
        for attempt in range(retries):
            item = self.acquire() if attempt == 0 else self._fresh()
            if item is None:
                last_err = "无可用通达信连接"
                continue
            broken = False
            try:
                return fn(api_of(item)), None
            except Exception as e:
                broken = True
                last_err = "%s: %s" % (type(e).__name__, str(e)[:120])
                with self._lock:
                    self.stats["errors"] += 1
            finally:
                if broken:
                    try:
                        api_of(item).disconnect()
                    except Exception:
                        pass
                    if attempt == 0:
                        # 坏连接丢弃，补一个新的回池，避免池被逐渐掏空
                        new = self._fresh()
                        if new:
                            with self._lock:
                                self.stats["reconnects"] += 1
                            self._q.put(new)
                else:
                    self._q.put(item)
        return None, last_err


# 8 台服务器 × 每台可建 1-2 个连接；选股时 200 只并发拉 K 线需要足够连接
pool = TdxPool(HOSTS, size=12)
executor = ThreadPoolExecutor(max_workers=12)


def api_of(item):
    return item[0]


# ---------- 业务函数 ----------

def _norm_quote(r, full_code):
    """pytdx 行情 → 与腾讯源一致的字段命名，便于 Node 侧无缝切换"""
    if not r:
        return None
    price = r.get("price")
    last = r.get("last_close")
    vol = r.get("vol")          # 手
    amount = r.get("amount")    # 元
    return {
        "fullCode": full_code,
        "code": r.get("code"),
        "market": "sh" if r.get("market") == 1 else ("bj" if r.get("market") == 2 else "sz"),
        "price": price,
        "prevClose": last,
        "open": r.get("open"),
        "high": r.get("high"),
        "low": r.get("low"),
        "volume": vol,
        "amountYuan": amount,
        "amountWan": amount / 10000 if amount else None,
        "change": (price - last) if (price is not None and last) else None,
        "changePct": ((price - last) / last * 100) if (price is not None and last) else None,
        "servertime": r.get("servertime"),
        # 通达信独有：五档盘口（腾讯源没有）
        "bidAsk": {
            "bid1": r.get("bid1"), "bidVol1": r.get("bid_vol1"),
            "ask1": r.get("ask1"), "askVol1": r.get("ask_vol1"),
            "bid2": r.get("bid2"), "bidVol2": r.get("bid_vol2"),
            "ask2": r.get("ask2"), "askVol2": r.get("ask_vol2"),
            "bid3": r.get("bid3"), "bidVol3": r.get("bid_vol3"),
            "ask3": r.get("ask3"), "askVol3": r.get("ask_vol3"),
            "bid4": r.get("bid4"), "bidVol4": r.get("bid_vol4"),
            "ask4": r.get("ask4"), "askVol4": r.get("ask_vol4"),
            "bid5": r.get("bid5"), "bidVol5": r.get("bid_vol5"),
            "ask5": r.get("ask5"), "askVol5": r.get("ask_vol5"),
        },
        # 换手率/市值/PE：通达信行情接口不直接给，标 None 不用假值
        "turnoverRate": None,
        "floatMvYi": None,
        "pe": None,
        "missing": ["换手率", "流通市值", "PE（通达信行情接口不提供，需其他源补充）"],
    }


def fetch_quotes(full_codes):
    """并发逐只查询（服务器限制单只查询）"""
    t0 = time.time()

    def one(full):
        market, code = split_code(full)
        res, err = pool.call(lambda api: api.get_security_quotes([(market, code)]))
        if err:
            return None
        arr = res or []
        r = arr[0] if arr else None
        return _norm_quote(r, full)

    rows = list(executor.map(one, full_codes))
    rows = [r for r in rows if r]
    return {
        "ok": len(rows) > 0,
        "rows": rows,
        "count": len(rows),
        "requested": len(full_codes),
        "elapsedMs": int((time.time() - t0) * 1000),
        "server": "通达信行情服务器（pytdx 直连）",
        "sourceLabel": "通达信（直连）",
    }


def _xdxr_factors(xdxr_rows):
    """
    除权除息表 → {日期字符串: 复权因子}
    因子含义：该日【及之前】的不复权价 × 因子 = 除权日之后的口径。

    标准公式（每 10 股）：
        送转 s = songzhuangu / 10
        配股 p = peigu / 10，配股价 pj
        分红 f = fenhong / 10（元/股，税前）
        除权参考价 ref = (P0 - f + pj * p) / (1 + s + p)
        因子        k  = ref / P0，其中 P0 为除权日前一交易日不复权收盘
    """
    fac = {}
    for r in (xdxr_rows or []):
        try:
            y, m, d = int(r["year"]), int(r["month"]), int(r["day"])
        except Exception:
            continue
        key = "%04d-%02d-%02d" % (y, m, d)
        fac[key] = {
            "fenhong": float(r.get("fenhong") or 0.0),
            "peigu": float(r.get("peigu") or 0.0),
            "peigujia": float(r.get("peigujia") or 0.0),
            "songzhuangu": float(r.get("songzhuangu") or 0.0),
        }
    return fac


def _apply_adjust(bars, xdxr_rows, mode):
    """
    在不复权序列上自算前/后复权。
    bars 为升序（旧 → 新），返回同样的列表结构（原地改副本）。
    """
    if mode == "none" or not bars:
        return bars
    fac = _xdxr_factors(xdxr_rows)
    if not fac:
        return bars

    out = [dict(b) for b in bars]
    n = len(out)
    # 每个除权日在序列中的位置
    events = []
    for i in range(1, n):
        dt = (out[i].get("datetime") or "")[:10]
        if dt in fac:
            prev_close = out[i - 1].get("close")
            if prev_close:
                events.append((i, dt, prev_close))
    if not events:
        return out

    if mode == "qfq":
        # 前复权：以最新价为基准，把历史价往下调
        # 从后往前，累计因子作用在更早的数据上
        cum = 1.0
        ev = sorted(events, key=lambda x: x[0], reverse=True)
        j = 0
        for i in range(n - 1, -1, -1):
            # 处理所有日期晚于当前 bar 的除权事件
            while j < len(ev) and ev[j][0] > i:
                _, dt, p0 = ev[j]
                f = fac[dt]
                s = f["songzhuangu"] / 10.0
                p = f["peigu"] / 10.0
                cash = f["fenhong"] / 10.0
                pj = f["peigujia"]
                ref = (p0 - cash + pj * p) / (1.0 + s + p)
                cum *= (ref / p0) if p0 else 1.0
                j += 1
            if cum != 1.0:
                for k in ("open", "close", "high", "low"):
                    if out[i].get(k) is not None:
                        out[i][k] = out[i][k] * cum
    elif mode == "hfq":
        # 后复权：以最早价为基准，把之后的价往上调
        cum = 1.0
        j = 0
        ev = sorted(events, key=lambda x: x[0])
        for i in range(n):
            while j < len(ev) and ev[j][0] <= i:
                _, dt, p0 = ev[j]
                f = fac[dt]
                s = f["songzhuangu"] / 10.0
                p = f["peigu"] / 10.0
                cash = f["fenhong"] / 10.0
                pj = f["peigujia"]
                ref = (p0 - cash + pj * p) / (1.0 + s + p)
                cum /= (ref / p0) if p0 else 1.0
                j += 1
            if cum != 1.0:
                for k in ("open", "close", "high", "low"):
                    if out[i].get(k) is not None:
                        out[i][k] = out[i][k] * cum
    return out


def fetch_kline(full_code, period="day", count=120, adjust="none"):
    market, code = split_code(full_code)
    cat = PERIOD_MAP.get(period, 9)
    t0 = time.time()
    res, err = pool.call(lambda api: api.get_security_bars(cat, market, code, 0, count))
    if err:
        return {"ok": False, "reason": "通达信 K 线取数失败：" + err}
    bars = res or []

    # 复权：通达信 K 线接口只给不复权序列，前/后复权用除权除息表自算
    adjust_used = adjust
    adjust_note = None
    if adjust in ("qfq", "hfq") and period == "day":
        xd, xerr = pool.call(lambda api: api.get_xdxr_info(market, code))
        if xerr:
            adjust_used = "none"
            adjust_note = "除权除息表取数失败，本次返回不复权：" + xerr
        else:
            bars = _apply_adjust(bars, xd, adjust)
            adjust_note = "前/后复权由本机基于通达信除权除息表自算（非上游直供）"
    elif adjust in ("qfq", "hfq"):
        adjust_used = "none"
        adjust_note = "复权仅支持日线（%s 周期返回不复权）" % period

    rows = []
    for b in bars:
        dt = b.get("datetime") or ""
        rows.append({
            "date": dt[:10],
            "datetime": dt,
            "open": b.get("open"),
            "close": b.get("close"),
            "high": b.get("high"),
            "low": b.get("low"),
            "volume": b.get("vol"),      # 手
            "amount": b.get("amount"),   # 元
        })
    return {
        "ok": len(rows) > 0,
        "rows": rows,
        "count": len(rows),
        "period": period,
        "fq": adjust_used,
        "fqNote": adjust_note,
        "elapsedMs": int((time.time() - t0) * 1000),
        "source": "tdx",
        "sourceLabel": "通达信（直连）",
    }


def fetch_intraday(full_code, count=60):
    """
    当日分时序列：用 5 分钟 K 线（category=0）回溯。

    为什么不直接用 get_minute_time_data：实测它返回的是压缩编码
    （price 出现 0.01 / -4885.56 这类无意义值），无法还原真实价格。
    5 分钟 K 线能给出 open/high/low/close/vol/amount，
    配合累计 amount/(累计 vol*100) 即可算真实分时均价线，
    且能回溯全天序列 —— 比只有"当前均价"的分时接口更能支撑
    「全天运行在均价线上方」这类判定。
    """
    market, code = split_code(full_code)
    t0 = time.time()
    res, err = pool.call(lambda api: api.get_security_bars(0, market, code, 0, count))
    if err:
        return {"ok": False, "reason": "通达信分时取数失败：" + err}
    bars = res or []
    rows = []
    cum_vol_hand = 0.0   # 累计成交量（手）
    cum_amount = 0.0     # 累计成交额（元）
    for b in bars:
        dt = b.get("datetime") or ""
        # 单位陷阱：pytdx 5 分钟 bar 的 vol 单位是「股」，而日线 bar 是「手」。
        # 实测茅台：5 分钟 bar 累计 3,833,500 == 日线 38,330 手，差 100 倍。
        # 这里统一归一为手，并直接算好累计均价，调用方不必再猜单位。
        vol_shares = b.get("vol") or 0
        vol_hand = vol_shares / 100.0
        amount = b.get("amount") or 0
        cum_vol_hand += vol_hand
        cum_amount += amount
        cum_avg = (cum_amount / (cum_vol_hand * 100.0)) if cum_vol_hand > 0 else None
        rows.append({
            "date": dt[:10],
            "time": dt[11:16] if len(dt) >= 16 else "",
            "datetime": dt,
            "open": b.get("open"),
            "close": b.get("close"),
            "high": b.get("high"),
            "low": b.get("low"),
            "volume": vol_hand,      # 手，与日线口径一致
            "amount": amount,        # 元
            "cumAvg": cum_avg,       # 当日累计分时均价
            "cumVol": cum_vol_hand,
        })
    # 只保留最后一个交易日的 bar：跨日会污染"当日均价线"和"当日新高"
    if rows:
        last_date = rows[-1]["date"]
        rows = [r for r in rows if r["date"] == last_date]
    return {
        "ok": len(rows) > 0,
        "rows": rows,
        "count": len(rows),
        "date": rows[-1]["date"] if rows else None,
        # 当日最终均价（= 全天成交额/成交量），实时行情口径与之一致
        "dayAvg": rows[-1]["cumAvg"] if rows else None,
        "elapsedMs": int((time.time() - t0) * 1000),
        "source": "tdx",
        "sourceLabel": "通达信（5 分钟序列）",
    }


def fetch_finance(full_code):
    """
    公司财务概览。核心价值是 ipo_date —— 通达信是本项目唯一能给出
    上市日期的通道，用于「上市不足 N 天次新股」的硬性排除。
    """
    market, code = split_code(full_code)
    res, err = pool.call(lambda api: api.get_finance_info(market, code))
    if err:
        return {"ok": False, "reason": err}
    r = res or {}
    ipo = r.get("ipo_date")
    ipo_str = None
    if ipo:
        s = str(ipo)
        # 通达信给的是 20010827 这种紧凑串
        if len(s) == 8 and s.isdigit():
            ipo_str = "%s-%s-%s" % (s[:4], s[4:6], s[6:])
        else:
            ipo_str = s[:10]
    return {
        "ok": bool(r),
        "ipoDate": ipo_str,
        "floatShares": r.get("liutongguben"),
        "totalShares": r.get("zongguben"),
        "industry": r.get("industry"),
        "updatedDate": str(r.get("updated_date") or "")[:10] or None,
    }


def fetch_xdxr(full_code):
    """除权除息：可用于自算前/后复权"""
    market, code = split_code(full_code)
    res, err = pool.call(lambda api: api.get_xdxr_info(market, code))
    if err:
        return {"ok": False, "reason": err}
    return {"ok": True, "rows": res or [], "count": len(res or [])}


# ---------- HTTP ----------

_cache = {}
_cache_lock = threading.Lock()


def cached(key, ttl, producer):
    now = time.time()
    with _cache_lock:
        hit = _cache.get(key)
        if hit and now - hit["at"] < ttl:
            return {**hit["data"], "cached": True}
    data = producer()
    with _cache_lock:
        _cache[key] = {"at": now, "data": data}
    return {**data, "cached": False}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _send(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False, default=str).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        try:
            if u.path == "/health":
                t0 = time.time()
                res, err = pool.call(lambda api: api.get_security_quotes([(1, "600519")]))
                ok = err is None and bool(res)
                self._send({
                    "ok": ok,
                    "reason": err,
                    "port": PORT,
                    "poolSize": pool._q.qsize(),
                    "stats": pool.stats,
                    "sample": (_norm_quote(res[0], "sh600519") if ok and res else None),
                    "elapsedMs": int((time.time() - t0) * 1000),
                    "fetchedAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
                })
            elif u.path == "/quotes":
                codes = (q.get("codes") or [""])[0]
                arr = [c for c in codes.split(",") if c]
                if not arr:
                    return self._send({"ok": False, "reason": "缺少 codes"}, 400)
                self._send(cached("q:" + ",".join(arr), 2, lambda: fetch_quotes(arr)))
            elif u.path == "/kline":
                code = (q.get("code") or [""])[0]
                period = (q.get("period") or ["day"])[0]
                count = min(int((q.get("count") or ["120"])[0]), 800)
                # 复权：none(默认) / qfq / hfq
                adjust = (q.get("adjust") or ["none"])[0]
                if adjust not in ("none", "qfq", "hfq"):
                    adjust = "none"
                if not code:
                    return self._send({"ok": False, "reason": "缺少 code"}, 400)
                self._send(cached("k:%s:%s:%d:%s" % (code, period, count, adjust), 10,
                                  lambda: fetch_kline(code, period, count, adjust)))
            elif u.path == "/xdxr":
                code = (q.get("code") or [""])[0]
                if not code:
                    return self._send({"ok": False, "reason": "缺少 code"}, 400)
                self._send(cached("x:" + code, 3600, lambda: fetch_xdxr(code)))
            elif u.path == "/intraday":
                code = (q.get("code") or [""])[0]
                count = min(int((q.get("count") or ["60"])[0]), 400)
                if not code:
                    return self._send({"ok": False, "reason": "缺少 code"}, 400)
                self._send(cached("i:%s:%d" % (code, count), 20,
                                  lambda: fetch_intraday(code, count)))
            elif u.path == "/finance":
                code = (q.get("code") or [""])[0]
                if not code:
                    return self._send({"ok": False, "reason": "缺少 code"}, 400)
                # 上市日期不变，缓存 24 小时
                self._send(cached("f:" + code, 86400, lambda: fetch_finance(code)))
            else:
                self._send({"ok": False, "reason": "未知路径 " + u.path}, 404)
        except Exception as e:
            self._send({"ok": False, "reason": "%s: %s" % (type(e).__name__, str(e)[:200])}, 500)


if __name__ == "__main__":
    # 端口协商：优先级 --port 参数 > 环境变量 TDX_PORT > 默认 8789。
    # 绑定后回写 stdout 的 PORT=<实际端口>（--port 0 时由系统分配），供 Electron 读取。
    import argparse
    _ap = argparse.ArgumentParser()
    _ap.add_argument("--port", type=int, default=None)
    _args = _ap.parse_known_args()[0]
    PORT = _args.port if _args.port is not None else int(os.environ.get("TDX_PORT", "8789"))
    httpd = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    _actual = httpd.server_address[1]
    print("PORT=%d" % _actual, flush=True)
    print("[tdx] starting on %d, hosts=%d" % (_actual, len(HOSTS)), flush=True)
    httpd.serve_forever()
