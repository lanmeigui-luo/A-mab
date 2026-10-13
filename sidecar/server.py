"""
A股博弈雷达 · AkShare sidecar（Python，端口 8788）

职责：提供 Node 通道拿不到的数据
  - 板块列表 / 成分股
  - 全市场涨跌家数、涨停池（情绪面）
  - 全市场个股资金流排名（资金面）

设计原则：
  1. 只转发 AkShare 的真实返回，不做任何补值或模拟
  2. 所有响应带 source / elapsedMs / fetchedAt，供前端标注来源
  3. 慢接口（资金流排名约 5s）走内存缓存，避免重复拉取
  4. 接口失败返回 ok=false + reason，前端显示「待接入」而非报错崩溃
"""

import json
import os
import sys
import time
import threading
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

# akshare 是补充源核心。包裹 ImportError：缺失时 sidecar 仍启动并对外声明「补充源不可用」，
# 由主进程/前端走 best-effort 横幅，不阻塞主窗口、不崩溃（满足降级要求）。
try:
    import akshare as ak
    AK_AVAILABLE = True
except ImportError:
    ak = None
    AK_AVAILABLE = False
    print("[sidecar] akshare 不可用，补充源（板块/资金流/涨停池）接口将返回不可用", file=sys.stderr)

# ---- py_mini_racer 包裹（预埋：当前无路由触发；部分 akshare 加密接口需要它）----
# 某些 akshare 接口（如 fund_flow 系列的加密请求参数）依赖 py_mini_racer 执行 JS。
# 这里不主动 import（避免无谓的启动成本，也**不**做「sys.path+import」式的假验证），
# 而是在真正调用处惰性加载并兜底——失败时只把该接口标为不可用，不拖垮整个 sidecar。
_MINI_RACER_MOD = None
MINI_RACER_AVAILABLE = False  # 仅代表「首次惰性加载成功」，不代表运行时已被接口验证


def _get_mini_racer():
    """惰性加载 py_mini_racer；失败返回 None，调用方据此把接口标为不可用。"""
    global _MINI_RACER_MOD, MINI_RACER_AVAILABLE
    if _MINI_RACER_MOD is not None:
        return _MINI_RACER_MOD
    try:
        import py_mini_racer as _m
        _MINI_RACER_MOD = _m
        MINI_RACER_AVAILABLE = True
        return _m
    except Exception:
        MINI_RACER_AVAILABLE = False
        return None


def with_mini_racer(producer, t0):
    """执行需要 py_mini_racer 的取数；不可用时返回 ok=False + reason，不崩溃。

    用法示例（未来启用加密接口时，直接复用，无需重新设计兜底）：
        def fund_flow_enc(...):
            def _work(mr):
                ctx = mr.context()
                ctx.eval(...)  # 解密参数
                return ok(ak.stock_fund_flow_xxx(...), time.time())
            return with_mini_racer(_work, time.time())
    """
    mr = _get_mini_racer()
    if mr is None:
        return fail("py_mini_racer 不可用，依赖加密接口的补充源已关闭（运行时未验证）", t0)
    try:
        return producer(mr)
    except Exception as e:
        return fail(f"加密接口调用失败：{type(e).__name__}: {str(e)[:180]}", t0)


# 东财域名经系统代理会间歇性失败（ProxyError），改为直连。
# 现象：同一时刻 15/30 分钟线成功、1/5/60 报 ProxyError，属代理层不稳定而非接口不可用。
_no_proxy = os.environ.get("NO_PROXY", "")
os.environ["NO_PROXY"] = (_no_proxy + ",eastmoney.com,.eastmoney.com").strip(",")
os.environ["no_proxy"] = os.environ["NO_PROXY"]

PORT = int(os.environ.get("PORT", "8788"))

# ---------- 缓存 ----------
_cache = {}
_cache_lock = threading.Lock()


def cached(key, ttl, producer):
    now = time.time()
    with _cache_lock:
        hit = _cache.get(key)
        if hit and now - hit["at"] < ttl:
            return {**hit["data"], "cached": True, "cacheAgeMs": int((now - hit["at"]) * 1000)}
    data = producer()
    with _cache_lock:
        _cache[key] = {"at": now, "data": data}
    return {**data, "cached": False}


def ok(payload, t0):
    payload.update({
        "ok": True,
        "elapsedMs": int((time.time() - t0) * 1000),
        "fetchedAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "source": "akshare",
    })
    return payload


def fail(reason, t0):
    return {
        "ok": False,
        "reason": reason,
        "elapsedMs": int((time.time() - t0) * 1000),
        "fetchedAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "source": "akshare",
    }


def df_records(df):
    """DataFrame → 可 JSON 化的记录列表"""
    df = df.copy()
    for c in df.columns:
        if str(df[c].dtype).startswith(("datetime", "date")):
            df[c] = df[c].astype(str)
    return json.loads(df.to_json(orient="records", force_ascii=False))


# ---------- 数据接口 ----------

SECTOR_INDICATOR = {"industry": "行业", "concept": "概念", "area": "地域"}


def board_list(btype="industry"):
    """
    板块列表（新浪）。
    选择新浪而非同花顺的理由：
      1. 行业/概念/地域三类接口一致，返回的 label 可直接用于下钻成分股
      2. 响应快（150-260ms）
      3. 同花顺概念板块行情接口实测返回两个月前的数据，不可用于实时排序
    """
    t0 = time.time()
    indicator = SECTOR_INDICATOR.get(btype, "行业")
    try:
        df = ak.stock_sector_spot(indicator=indicator)
        rows = df_records(df)
        out = []
        for r in rows:
            out.append({
                "label": r.get("label"),
                "name": r.get("板块"),
                "count": r.get("公司家数"),
                "avgPrice": r.get("平均价格"),
                "change": r.get("涨跌额"),
                "changePct": r.get("涨跌幅"),
                "volume": r.get("总成交量"),
                "amount": r.get("总成交额"),
                "leadCode": r.get("股票代码"),
                "leadName": r.get("股票名称"),
                "leadChangePct": r.get("个股-涨跌幅"),
                "leadPrice": r.get("个股-当前价"),
            })
        return ok({"rows": out, "count": len(out), "type": btype, "indicator": indicator}, t0)
    except Exception as e:
        return fail(f"板块列表失败：{type(e).__name__}: {str(e)[:180]}", t0)


def kline_min(code, period="5", adjust="qfq", limit=320):
    """
    分钟 K 线（东财）。腾讯 fqkline 不支持分钟周期，AkShare 可补上。
    period: 1/5/15/30/60
    adjust: qfq / hfq / ""（不复权）
    """
    t0 = time.time()
    if not code:
        return fail("缺少 code 参数", t0)

    # 东财分钟线在本机是**间歇性可达**：同一时刻 15/60 分钟成功、1/5/30 失败，
    # 走代理与直连都可能出现 RemoteDisconnected。
    # 对策：重试 6 次并在「系统代理 / 直连」之间交替，实测可显著提高成功率。
    proxy_keys = ("NO_PROXY", "no_proxy")
    saved = {k: os.environ.get(k) for k in proxy_keys}
    last_err = None

    for attempt in range(6):
        if attempt % 2 == 0:
            for k in proxy_keys:
                if saved[k] is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = saved[k]
        else:
            os.environ["NO_PROXY"] = "*"
            os.environ["no_proxy"] = "*"
        try:
            df = ak.stock_zh_a_hist_min_em(symbol=code, period=str(period), adjust=adjust)
            rows = df_records(df)
            if limit and len(rows) > limit:
                rows = rows[-limit:]
            out = []
            for r in rows:
                out.append({
                    "datetime": r.get("时间"),
                    "open": r.get("开盘"),
                    "close": r.get("收盘"),
                    "high": r.get("最高"),
                    "low": r.get("最低"),
                    "volume": r.get("成交量"),
                    "amount": r.get("成交额"),
                    "avgPrice": r.get("均价"),
                    "changePct": r.get("涨跌幅"),
                    "turnoverRate": r.get("换手率"),
                })
            return ok({
                "rows": out,
                "count": len(out),
                "code": code,
                "period": str(period),
                "adjust": adjust or "none",
                "attempts": attempt + 1,
            }, t0)
        except Exception as e:
            last_err = e
            time.sleep(0.4 * (attempt + 1))
        finally:
            for k in proxy_keys:
                if saved[k] is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = saved[k]

    return fail(
        f"分钟K失败（已重试 6 次，代理/直连交替）：{type(last_err).__name__}: {str(last_err)[:140]}", t0
    )


def board_cons(sector):
    """板块成分股（新浪）。sector 取自板块列表的 label，如 hangye_ZA01 / gn_hwqc / diyu_650000"""
    t0 = time.time()
    if not sector:
        return fail("缺少 sector 参数", t0)
    try:
        df = ak.stock_sector_detail(sector=sector)
        rows = df_records(df)
        out = []
        for r in rows:
            out.append({
                "fullCode": r.get("symbol"),
                "code": r.get("code"),
                "name": r.get("name"),
                "price": r.get("trade"),
                "change": r.get("pricechange"),
                "changePct": r.get("changepercent"),
                "open": r.get("open"),
                "high": r.get("high"),
                "low": r.get("low"),
                "prevClose": r.get("settlement"),
                "volume": r.get("volume"),
                "amount": r.get("amount"),
                "pe": r.get("per"),
                "pb": r.get("pb"),
                "turnoverRate": r.get("turnoverratio"),
                "floatMvWan": r.get("nmc"),
                "totalMvWan": r.get("mktcap"),
                "tickTime": r.get("ticktime"),
            })
        return ok({"rows": out, "count": len(out), "sector": sector}, t0)
    except Exception as e:
        return fail(f"成分股失败：{type(e).__name__}: {str(e)[:180]}", t0)


def market_stats():
    """全市场涨跌家数（乐咕）"""
    t0 = time.time()
    try:
        df = ak.stock_market_activity_legu()
        m = {}
        for r in df_records(df):
            try:
                m[str(r.get("item"))] = float(r.get("value"))
            except (TypeError, ValueError):
                pass
        return ok({
            "up": m.get("上涨"),
            "down": m.get("下跌"),
            "flat": m.get("平盘"),
            "limitUp": m.get("涨停"),
            "limitDown": m.get("跌停"),
            "suspension": m.get("停牌"),
            "raw": m,
        }, t0)
    except Exception as e:
        return fail(f"涨跌家数失败：{type(e).__name__}: {str(e)[:180]}", t0)


def _limit_down_count():
    """
    当日跌停家数（东财跌停池）。
    失败返回 None —— 上层会把「取不到」与「0 家」区分开，
    因为隔夜战法用它做空仓门禁，假 0 会让退潮期的风控失效。
    """
    import datetime as _dt
    for day in [time.strftime("%Y%m%d")] + _recent_trade_dates(5):
        try:
            df = ak.stock_zt_pool_dtgc_em(date=day)
            rows = df_records(df)
            if rows:
                return len(rows)
        except Exception:
            continue
    return None


def limit_up_pool():
    """涨停池 → 情绪面（涨停家数、连板高度、炸板率）"""
    t0 = time.time()
    try:
        df = ak.stock_zt_pool_em(date=time.strftime("%Y%m%d"))
        rows = df_records(df)
        boards = []
        broken = 0
        # 按个股透出连板结构，供「连板晋级」战法使用（真实字段，非推断）
        boards_by_code = {}
        for r in rows:
            code = str(r.get("代码") or "").zfill(6)
            try:
                b = int(r.get("连板数") or 1)
            except (TypeError, ValueError):
                b = 1
            try:
                br = int(r.get("炸板次数") or 0)
            except (TypeError, ValueError):
                br = 0
            boards.append(b)
            if br > 0:
                broken += 1
            if code:
                boards_by_code[code] = {
                    "board": b,
                    "broken": br,
                    "sealYuan": r.get("封板资金"),
                    "firstSeal": r.get("首次封板时间"),
                    "lastSeal": r.get("最后封板时间"),
                    "industry": r.get("所属行业"),
                }
        return ok({
            "rows": rows,
            "count": len(rows),
            "maxBoard": max(boards) if boards else None,
            "brokenCount": broken,
            "brokenRate": round(broken / len(rows) * 100, 2) if rows else None,
            "boardsByCode": boards_by_code,
            # 跌停家数：隔夜持股法的情绪退潮门禁需要它（跌停 > 30 家 → 强制空仓）。
            # 涨停池接口不含跌停，必须单独取；取不到时给 None，
            # 由上层按「数据缺失」处理，绝不用 0 假装市场没有跌停。
            "limitDownCount": _limit_down_count(),
        }, t0)
    except Exception as e:
        return fail(f"涨停池失败：{type(e).__name__}: {str(e)[:180]}", t0)


def _recent_trade_dates(max_days=7):
    """最近若干个可能的交易日（自然日倒序），用于取「上一交易日」涨停池"""
    import datetime as _dt
    out = []
    d = _dt.date.today()
    for i in range(1, max_days + 1):
        out.append((d - _dt.timedelta(days=i)).strftime("%Y%m%d"))
    return out


def prev_limit_up_pool():
    """
    上一交易日涨停池 → 晋级率与「昨日涨停今日表现」的基准。
    只返回代码与连板数，今日表现在 Node 侧用腾讯行情真算（更快、不依赖东财）。
    """
    t0 = time.time()
    for day in _recent_trade_dates():
        try:
            df = ak.stock_zt_pool_em(date=day)
            rows = df_records(df)
            if not rows:
                continue
            items = []
            for r in rows:
                code = str(r.get("代码") or "").zfill(6)
                if not code:
                    continue
                try:
                    b = int(r.get("连板数") or 1)
                except (TypeError, ValueError):
                    b = 1
                items.append({"code": code, "board": b, "name": r.get("名称")})
            return ok({
                "date": day,
                "count": len(items),
                "items": items,
            }, t0)
        except Exception:
            continue
    return fail("上一交易日涨停池取数失败（已回溯 7 个自然日）", t0)


def fund_rank():
    """全市场个股资金流排名（约 5s，缓存 60s）"""
    t0 = time.time()
    try:
        df = ak.stock_fund_flow_individual(symbol="即时")
        recs = df_records(df)

        def to_num(v):
            """'15.95亿' / '4907.35万' / '-1234' → 元"""
            if v is None:
                return None
            s = str(v).strip()
            if not s or s in ("-", "--"):
                return None
            mul = 1.0
            if s.endswith("万亿"):
                mul, s = 1e12, s[:-2]
            elif s.endswith("亿"):
                mul, s = 1e8, s[:-1]
            elif s.endswith("万"):
                mul, s = 1e4, s[:-1]
            try:
                return float(s) * mul
            except ValueError:
                return None

        out = []
        for r in recs:
            code = str(r.get("股票代码") or "").zfill(6)
            out.append({
                "code": code,
                "name": r.get("股票简称"),
                "price": r.get("最新价"),
                "changePct": r.get("涨跌幅"),
                "turnoverRate": r.get("换手率"),
                "netYuan": to_num(r.get("净额")),
                "inflowYuan": to_num(r.get("流入资金")),
                "outflowYuan": to_num(r.get("流出资金")),
                "amountYuan": to_num(r.get("成交额")),
            })
        return ok({"rows": out, "count": len(out)}, t0)
    except Exception as e:
        return fail(f"资金流排名失败：{type(e).__name__}: {str(e)[:180]}", t0)


MAP_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "board_map.json")


def _cons_codes(sector):
    """取板块成分股代码（内部用，失败返回空列表，不中断整体构建）"""
    try:
        df = ak.stock_sector_detail(sector=sector)
        return [str(c).zfill(6) for c in df["code"].tolist()]
    except Exception:
        return []


def build_board_map(btype="industry"):
    """
    构建「个股 → 所属板块」映射 + 「板块 → 涨跌幅」。

    用途：给确定性评分补齐板块面因子（需求权重 15%）。
    代价：需逐个板块拉取成分股，用 8 线程并发后行业约 4-6 秒。
    结果落盘 board_map.json，重启后可直接复用（板块成分不频繁变动）。
    """
    t0 = time.time()
    indicator = SECTOR_INDICATOR.get(btype, "行业")
    try:
        df = ak.stock_sector_spot(indicator=indicator)
        boards = []
        for r in df_records(df):
            name = r.get("板块")
            if not name:
                continue
            boards.append({
                "label": r.get("label"),
                "name": name,
                "changePct": r.get("涨跌幅"),
                "count": r.get("公司家数"),
            })

        labels = [b["label"] for b in boards if b.get("label")]
        with ThreadPoolExecutor(max_workers=8) as ex:
            cons = list(ex.map(_cons_codes, labels))

        code_to_board = {}
        board_pct = {}
        for b, codes in zip([b for b in boards if b.get("label")], cons):
            board_pct[b["name"]] = b["changePct"]
            for c in codes:
                # 一只票可能属于多个板块（行业/概念），行业维度唯一，概念维度取第一个
                code_to_board.setdefault(c, b["name"])

        payload = {
            "type": btype,
            "indicator": indicator,
            "boardCount": len(boards),
            "mappedStocks": len(code_to_board),
            "boards": board_pct,
            "codeToBoard": code_to_board,
            "builtAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
        }
        try:
            with open(MAP_FILE, "w", encoding="utf-8") as f:
                json.dump(payload, f, ensure_ascii=False)
        except Exception:
            pass
        return ok(payload, t0)
    except Exception as e:
        return fail(f"板块映射构建失败：{type(e).__name__}: {str(e)[:180]}", t0)


def load_map_from_disk():
    if not os.path.exists(MAP_FILE):
        return None
    try:
        with open(MAP_FILE, "r", encoding="utf-8") as f:
            d = json.load(f)
        age = time.time() - os.path.getmtime(MAP_FILE)
        return {**d, "fromDisk": True, "ageSec": int(age)}
    except Exception:
        return None


def _fund_rank_rows(df):
    """资金流表 → [{rank, name, net}]，按净额降序。净额单位为亿元。"""
    out = []
    for r in df_records(df):
        name = str(r.get("行业") or r.get("名称") or "").strip()
        if not name:
            continue
        try:
            net = float(r.get("净额"))
        except (TypeError, ValueError):
            continue
        try:
            pct = float(r.get("行业-涨跌幅"))
        except (TypeError, ValueError):
            pct = None
        out.append({"name": name, "net": net, "changePct": pct})
    out.sort(key=lambda x: -x["net"])
    for i, x in enumerate(out):
        x["rank"] = i + 1
    return out


def board_fund():
    """
    板块资金净流入排名 —— 隔夜持股法「所属板块属当日资金净流入前 3」的排名来源。

    口径按需求确认：**概念为主，行业作校验**。

    这里只出排名，不做成分股。原因（实测）：
      东财成分股接口 stock_board_concept_cons_em / stock_board_industry_cons_em
      6/6 重试全部 ConnectionError，行业与概念都不可用；
      stock_individual_fund_flow_rank 同样被限流。
      因此「个股 → 板块」改由 /board/belong 反向查询（efinance get_belong_board），
      它返回东财 BK 板块名，与本表名称同体系，实测 200 只样本
      概念口径命中率 96%、行业 57%。
    """
    t0 = time.time()
    try:
        concept = _fund_rank_rows(ak.stock_fund_flow_concept(symbol="即时"))
    except Exception as e:
        return fail(f"概念资金流（主口径）失败：{type(e).__name__}: {str(e)[:180]}", t0)
    try:
        industry = _fund_rank_rows(ak.stock_fund_flow_industry(symbol="即时"))
        err_note = None
    except Exception as e:
        industry = []
        err_note = f"行业资金流（校验层）取数失败：{type(e).__name__}: {str(e)[:120]}"

    return ok({
        "main": "concept",
        "validate": "industry",
        "concept": concept,
        "industry": industry,
        "conceptTop3": [{"name": x["name"], "net": x["net"], "changePct": x["changePct"]} for x in concept[:3]],
        "industryTop3": [{"name": x["name"], "net": x["net"], "changePct": x["changePct"]} for x in industry[:3]],
        "conceptRank": {x["name"]: {"rank": x["rank"], "net": x["net"]} for x in concept},
        "industryRank": {x["name"]: {"rank": x["rank"], "net": x["net"]} for x in industry},
        "note": err_note,
        "unit": "净额单位为亿元",
        "memberSource": "/board/belong（反向查询，非成分股接口）",
    }, t0)


_ef_mod = None


def _efinance():
    """延迟导入 efinance：它 import 较慢，且只在本接口用到"""
    global _ef_mod
    if _ef_mod is None:
        import efinance as _m
        _ef_mod = _m
    return _ef_mod


def _belong_one(ef, code):
    """单只股票 → 所属东财板块名列表。返回空列表表示取数失败（由上层判 na）"""
    try:
        r = ef.stock.get_belong_board(code)
        names = [str(x).strip() for x in r["板块名称"].tolist() if str(x).strip()]
        return code, names
    except Exception:
        return code, []


def board_belong(codes):
    """
    个股 → 所属东财板块（反向查询）。

    为什么反向：东财正向成分股接口已被限流不可用（见 board_fund 注释）。
    efinance 的 get_belong_board 走的是另一条通道，实测 200/200 成功、
    单只 89-382ms，返回 BK 板块名 + 板块涨幅，与东财资金流表同体系。

    返回的板块名包含行业/概念/地域/风格四类，调用方只需拿名称去匹配
    资金流排名表，匹配不上（地域、风格）的自然被忽略，无需额外过滤。
    """
    t0 = time.time()
    if not codes:
        return fail("缺少 codes", t0)
    try:
        ef = _efinance()
    except Exception as e:
        return fail(f"efinance 不可用：{type(e).__name__}: {str(e)[:160]}", t0)

    uniq = []
    seen = set()
    for c in codes:
        c = str(c).zfill(6)
        if c and c not in seen:
            seen.add(c)
            uniq.append(c)

    mapped = {}
    with ThreadPoolExecutor(max_workers=8) as ex:
        for code, names in ex.map(lambda c: _belong_one(ef, c), uniq):
            mapped[code] = names
    hit = sum(1 for v in mapped.values() if v)
    return ok({
        "codeToBoards": mapped,
        "requested": len(uniq),
        "mapped": hit,
        "failed": len(uniq) - hit,
    }, t0)


def board_map(btype="industry"):
    """优先读磁盘缓存（6 小时内），否则重建"""
    d = load_map_from_disk()
    if d and d.get("type") == btype and (d.get("ageSec") or 1e9) < 6 * 3600:
        return ok({**d, "ok": True, "source": "akshare"}, time.time())
    return build_board_map(btype)


ROUTES = {
    "/board/list": lambda q: cached(
        "board:list:" + (q.get("type") or ["industry"])[0], 30,
        lambda: board_list((q.get("type") or ["industry"])[0]),
    ),
    "/board/cons": lambda q: cached(
        "board:cons:" + (q.get("sector") or [""])[0], 30,
        lambda: board_cons((q.get("sector") or [""])[0]),
    ),
    "/kline/min": lambda q: cached(
        "kmin:%s:%s:%s:%s" % (
            (q.get("code") or [""])[0],
            (q.get("period") or ["5"])[0],
            (q.get("adjust") or ["qfq"])[0],
            (q.get("limit") or ["320"])[0],
        ),
        20,
        lambda: kline_min(
            (q.get("code") or [""])[0],
            (q.get("period") or ["5"])[0],
            (q.get("adjust") or ["qfq"])[0],
            int((q.get("limit") or ["320"])[0]),
        ),
    ),
    "/board/map": lambda q: board_map((q.get("type") or ["industry"])[0]),
    "/board/fund": lambda q: cached("board:fund", 300, lambda: board_fund()),
    "/board/belong": lambda q: cached(
        "board:belong:" + ",".join(sorted((q.get("codes") or [""])[0].split(","))),
        21600,  # 板块归属稳定，缓存 6 小时
        lambda: board_belong([c for c in (q.get("codes") or [""])[0].split(",") if c]),
    ),
    "/market/stats": lambda q: cached("market:stats", 10, market_stats),
    "/market/limitup": lambda q: cached("market:limitup", 30, limit_up_pool),
    "/market/prev-limitup": lambda q: cached("market:prevlimitup", 300, prev_limit_up_pool),
    "/fund/rank": lambda q: cached("fund:rank", 60, fund_rank),
}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass  # 静默，避免刷屏

    def _send(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        if u.path == "/health":
            return self._send(200, {
                "ok": True,
                "akshareAvailable": AK_AVAILABLE,
                "akshareVersion": (ak.__version__ if AK_AVAILABLE else "n/a"),
                # 仅反映「惰性加载是否成功」，不代表运行时已被接口验证（当前无路由触发）
                "miniRacerAvailable": MINI_RACER_AVAILABLE,
                "routes": sorted(ROUTES.keys()),
                "time": time.strftime("%Y-%m-%dT%H:%M:%S"),
            })
        # akshare 不可用：除 /health 外一律返回 503，主进程/前端走 best-effort 横幅
        if not AK_AVAILABLE:
            return self._send(503, {"ok": False, "reason": "akshare 不可用，补充源（板块/资金流/涨停池）已关闭"})
        fn = ROUTES.get(u.path)
        if not fn:
            return self._send(404, {"ok": False, "reason": "not found: " + u.path})
        try:
            self._send(200, fn(q))
        except Exception as e:
            self._send(502, {"ok": False, "reason": f"{type(e).__name__}: {str(e)[:200]}"})


if __name__ == "__main__":
    # 端口协商：优先级 --port 参数 > 环境变量 PORT > 默认 8788。
    # 绑定后回写 stdout 的 PORT=<实际端口>（--port 0 时由系统分配），供 Electron 读取。
    import argparse
    _ap = argparse.ArgumentParser()
    _ap.add_argument("--port", type=int, default=None)
    _args = _ap.parse_known_args()[0]
    PORT = _args.port if _args.port is not None else int(os.environ.get("PORT", "8788"))
    httpd = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    _actual = httpd.server_address[1]
    print("PORT=%d" % _actual, flush=True)
    print("[akshare-sidecar] http://127.0.0.1:%d akshare=%s" % (_actual, "n/a" if not AK_AVAILABLE else ak.__version__), flush=True)
    httpd.serve_forever()
