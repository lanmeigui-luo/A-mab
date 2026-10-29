import { useMemo, useState } from 'react';
import type { KlineRow, MinuteRow } from '@/domain/types';
import type { StrategyHit, TradePlan } from '@/domain/strategy';
import { changeColor, formatPct, formatChange } from '@/lib/market-colors';
import { calcMA, calcBOLL, calcMACD, calcKDJ, calcRSI, rangeStats } from '@/lib/indicators';
import { fmtNum, fmtVolume } from '@/lib/format';

export type SubIndicator = 'vol' | 'macd' | 'kdj' | 'rsi';

interface Props {
  rows: KlineRow[];
  /** 分时数据（MinuteRow[]）；若提供且非空，进入分时渲染模式，忽略 rows */
  intraday?: MinuteRow[] | null;
  /** 分时昨收参考线（元）；为 null 时省略昨收线 */
  prevClose?: number | null;
  /** K 线模式的 MA 显示开关（分时模式忽略） */
  showMa?: boolean;
  /** K 线模式的 BOLL 显示开关（分时模式忽略） */
  showBoll?: boolean;
  /** 副图指标 */
  sub?: SubIndicator;
  /** 买卖价推荐（规则引擎算出的真实价位） */
  plan?: TradePlan | null;
  /** 命中战法信号 */
  signals?: StrategyHit[];
}

const W = 900;
const H = 470;
const PAD_L = 58;
const PAD_R = 14;
const PAD_T = 12;
const MAIN_H = 258;
const GAP = 14;
const SUB_H = 96;
const PANEL_GAP = 18;

/** 同花顺式固定时间轴：整个交易日恒为 242 个刻度槽（含 09:30 与 15:00） */
const INTRADAY_SLOT_COUNT = 242;
/** 槽位 → x 坐标：槽 0 落在左轴内边距处，槽 241 落在右轴内边距处；禁止等距按点数铺满 */
const intradaySlotX = (slot: number) =>
  PAD_L + (slot / (INTRADAY_SLOT_COUNT - 1)) * (W - PAD_L - PAD_R);
/** 解析分时时间 → 槽位。支持 "09:30" / "T09:30:00" / "0930" 三种格式；午休、盘前盘后一律返回 null 丢弃，不占位 */
function intradaySlot(time: string): number | null {
  let t = time.trim();
  if (t.startsWith('T') || t.startsWith('t')) t = t.slice(1);
  let hh: number;
  let mm: number;
  if (t.includes(':')) {
    const parts = t.split(':');
    hh = parseInt(parts[0], 10);
    mm = parseInt(parts[1] ?? '0', 10);
  } else if (/^\d{3,4}$/.test(t)) {
    hh = parseInt(t.slice(0, t.length - 2), 10);
    mm = parseInt(t.slice(t.length - 2), 10);
  } else {
    return null;
  }
  if (Number.isNaN(hh) || Number.isNaN(mm)) return null;
  if (hh === 9 && mm >= 30) return mm - 30;                 // 09:30(0) .. 09:59(29)
  if (hh === 10) return 30 + mm;                            // 10:00(30) .. 10:59(89)
  if (hh === 11 && mm <= 30) return 90 + mm;                // 11:00(90) .. 11:30(120)
  if (hh >= 13 && hh < 15) return 121 + (hh - 13) * 60 + mm; // 13:00(121) .. 14:59(240)
  if (hh === 15 && mm === 0) return 241;                    // 15:00(241)
  return null;                                              // 午休 / 盘前 / 盘后
}

/** 分时成交量副图柱（固定时间轴专用） */
interface IntradayVolBar {
  x: number;
  w: number;
  volTop: number;
  color: string;
}

const MA_COLORS = { ma5: '#f59e0b', ma10: '#3b82f6', ma20: '#a855f7' };
/** 买卖点标注配色：不与红涨绿跌冲突（需求 7.2） */
const PLAN_COLORS = {
  buy: '#d4a017',
  stop: '#2563eb',
  target: '#7c3aed',
};
/** 分时均价线配色 */
const AVG_COLOR = '#f59e0b';

export function KlineChart({ rows, intraday: intradayProp, prevClose = null, showMa = true, showBoll = false, sub = 'vol', plan = null, signals = [] }: Props) {
  const [hover, setHover] = useState<number | null>(null);
  const [sigOpen, setSigOpen] = useState(false);
  const intraday = useMemo(() => (intradayProp && intradayProp.length ? intradayProp : null), [intradayProp]);

  const view = useMemo(() => {
    if (!rows.length && !intraday) return null;

    // ===== 分时渲染模式（同花顺式固定时间轴） =====
    if (intraday) {
      const innerW = W - PAD_L - PAD_R;
      const slotX = intradaySlotX;

      // 数据按时间槽位映射：price/avg 无值填 null，vol 无值填 0
      const price = new Array<number | null>(INTRADAY_SLOT_COUNT).fill(null);
      const avg = new Array<number | null>(INTRADAY_SLOT_COUNT).fill(null);
      const vol = new Array<number>(INTRADAY_SLOT_COUNT).fill(0);
      const intradayBySlot: (MinuteRow | null)[] = new Array(INTRADAY_SLOT_COUNT).fill(null);
      let validCount = 0;
      let firstValidSlot = -1;
      let lastValidSlot = -1;
      for (const r of intraday) {
        const s = intradaySlot(r.time);
        if (s == null) continue; // 午休 / 盘前盘后脏数据丢弃，不占位
        price[s] = r.price;
        avg[s] = r.avg;
        vol[s] = r.vol;
        intradayBySlot[s] = r;
        validCount++;
        if (firstValidSlot < 0) firstValidSlot = s;
        lastValidSlot = s;
      }
      // 一个有效点都没有 → 返回 null，交由顶层渲染「暂无分时数据」
      if (validCount === 0) return null;

      // 纵轴范围必须把 prevClose 一起纳入，避免昨收参考线被裁掉
      let priceHi = -Infinity;
      let priceLo = Infinity;
      for (const p of price) {
        if (p != null) {
          priceHi = Math.max(priceHi, p);
          priceLo = Math.min(priceLo, p);
        }
      }
      let hi = priceHi;
      let lo = priceLo;
      if (prevClose != null) {
        hi = Math.max(hi, prevClose);
        lo = Math.min(lo, prevClose);
      }
      // 买卖计划价位纳入纵轴范围，否则标注线会画到画布外
      for (const p of [plan?.buyLow, plan?.buyHigh, plan?.stop, plan?.target1, plan?.target2]) {
        if (p != null) {
          hi = Math.max(hi, p);
          lo = Math.min(lo, p);
        }
      }
      const pad = (hi - lo) * 0.06 || hi * 0.01 || 1;
      hi += pad;
      lo -= pad;

      const mainBottom = PAD_T + MAIN_H;
      const y = (p: number) => mainBottom - ((p - lo) / (hi - lo)) * MAIN_H;

      const subTop = mainBottom + GAP;
      const subBottom = subTop + SUB_H;
      const maxVol = Math.max(1, ...vol);
      const vy = (v: number) => subBottom - (v / maxVol) * SUB_H;

      // 价格线 / 均价线：遇到 null 断开（M 重新起笔），只有有数据的段才画线
      const linePath = (arr: (number | null)[]): string => {
        let d = '';
        let pen = false;
        for (let s = 0; s < arr.length; s++) {
          const v = arr[s];
          if (v == null) {
            pen = false;
            continue;
          }
          const x = slotX(s).toFixed(1);
          const yy = y(v).toFixed(1);
          d += pen ? ` L${x},${yy}` : `M${x},${yy}`;
          pen = true;
        }
        return d;
      };
      // 价格折线（整条颜色按末价相对昨收决定红涨绿跌）
      const pricePath = linePath(price);
      // 均价折线（后端自算）；任一为空则整条不画
      const avgPath = price.some((_, s) => avg[s] != null) ? linePath(avg) : '';

      const lastPrice = price[lastValidSlot] as number;
      const base = prevClose != null ? prevClose : (price[firstValidSlot] as number);
      const priceColor = changeColor(lastPrice - base);
      const prevCloseY = prevClose != null ? y(prevClose) : null;

      // 成交量副图：只对 vol>0 的槽画柱，为 0 的分钟不画柱 = 留白
      const barW = Math.max(1, innerW / INTRADAY_SLOT_COUNT - 1);
      const volBars: IntradayVolBar[] = [];
      for (let s = 0; s < INTRADAY_SLOT_COUNT; s++) {
        if (vol[s] > 0) {
          volBars.push({
            x: slotX(s) - barW / 2,
            w: barW,
            volTop: vy(vol[s]),
            color: changeColor(prevClose != null ? (price[s] as number) - prevClose : 0),
          });
        }
      }

      const gridCount = 4;
      const gridLines = Array.from({ length: gridCount + 1 }, (_, k) => {
        const p = lo + ((hi - lo) * k) / gridCount;
        return { y: y(p), value: p };
      });

      // 横轴刻度固定（同花顺式）：09:30 / 10:30 / 11:30-13:00 / 14:00 / 15:00
      const xLabels = [
        { x: slotX(0), text: '09:30' },
        { x: slotX(60), text: '10:30' },
        { x: slotX(120), text: '11:30/13:00' },
        { x: slotX(181), text: '14:00' },
        { x: slotX(241), text: '15:00' },
      ];

      // 买卖点标注（只在价格落在纵轴范围内时画）
      const planLines = [
        plan?.buyLow != null && plan?.buyHigh != null && !plan.buyBlockedByLimitUp
          ? { kind: 'band', from: y(plan.buyLow), to: y(plan.buyHigh), color: PLAN_COLORS.buy, text: `买入区间 ${fmtNum(plan.buyLow)}~${fmtNum(plan.buyHigh)}` }
          : null,
        plan?.stop != null
          ? { kind: 'line', y: y(plan.stop), color: PLAN_COLORS.stop, text: `止损 ${fmtNum(plan.stop)}` }
          : null,
        plan?.target1 != null
          ? { kind: 'line', y: y(plan.target1), color: PLAN_COLORS.target, text: `目标1 ${fmtNum(plan.target1)}` }
          : null,
        plan?.target2 != null
          ? { kind: 'line', y: y(plan.target2), color: PLAN_COLORS.target, text: `目标2 ${fmtNum(plan.target2)}` }
          : null,
      ].filter(Boolean) as { kind: string; y?: number; from?: number; to?: number; color: string; text: string }[];

      // 当日统计
      const changePct = base ? ((lastPrice - base) / base) * 100 : 0;
      const stats = {
        days: validCount,
        changePct,
        high: priceHi,
        low: priceLo,
        volume: vol.reduce((s, v) => s + v, 0),
      };
      // 图上方实时浮标：当前价 + 相对昨收涨跌（随分时轮询更新，区别于 header 的行情快照）
      const changeVal = base ? lastPrice - base : 0;
      const intradayHead = { price: lastPrice, changeVal, changePct, color: priceColor };

      const lastX = lastValidSlot >= 0 ? slotX(lastValidSlot) : PAD_L;
      // slot 仅供 K 线模式 hover 计算复用；分时不再依赖它
      const slot = innerW / INTRADAY_SLOT_COUNT;

      return {
        isIntraday: true,
        pricePath,
        avgPath,
        priceColor,
        prevCloseY,
        volBars,
        gridLines,
        xLabels,
        slot,
        subTop,
        subBottom,
        planLines,
        stats,
        intradayHead,
        lastX,
        intraday,
        intradayBySlot,
        // 占位（K 线模式专用，分时不用）
        candles: [] as unknown as KlineChartCandle[],
        maPaths: [] as { key: string; d: string; color: string }[],
        bollPaths: [] as { key: string; d: string; color: string }[],
        bodyW: 0,
        subLo: 0,
        subHi: 0,
        sy: (_v: number) => 0,
        macd: null,
        kdj: null,
        rsi: null,
        subPath: (_a: (number | null)[]) => '',
        ma: { ma5: [] as (number | null)[], ma10: [] as (number | null)[], ma20: [] as (number | null)[] },
        boll: { upper: [] as (number | null)[], mid: [] as (number | null)[], lower: [] as (number | null)[] },
      };
    }

    // ===== K 线渲染模式 =====
    const n = rows.length;
    const plotW = W - PAD_L - PAD_R;
    const slot = plotW / n;
    const bodyW = Math.max(2, Math.min(14, slot * 0.62));

    const highs = rows.map((r) => r.high);
    const lows = rows.map((r) => r.low);
    let hi = Math.max(...highs);
    let lo = Math.min(...lows);
    const ma = calcMA(rows);
    const boll = calcBOLL(rows);
    if (showMa) {
      for (const key of ['ma5', 'ma10', 'ma20'] as const) {
        for (const v of ma[key]) if (v != null) { hi = Math.max(hi, v); lo = Math.min(lo, v); }
      }
    }
    if (showBoll) {
      for (const v of boll.upper) if (v != null) hi = Math.max(hi, v);
      for (const v of boll.lower) if (v != null) lo = Math.min(lo, v);
    }
    // 买卖计划价位纳入纵轴范围，否则标注线会画到画布外
    for (const p of [plan?.buyLow, plan?.buyHigh, plan?.stop, plan?.target1, plan?.target2]) {
      if (p != null) { hi = Math.max(hi, p); lo = Math.min(lo, p); }
    }
    const pad = (hi - lo) * 0.06 || hi * 0.01 || 1;
    hi += pad;
    lo -= pad;

    const mainBottom = PAD_T + MAIN_H;
    const y = (p: number) => mainBottom - ((p - lo) / (hi - lo)) * MAIN_H;

    const subTop = mainBottom + GAP;
    const subBottom = subTop + SUB_H;
    const maxVol = Math.max(...rows.map((r) => r.volume), 1);
    const vy = (v: number) => subBottom - (v / maxVol) * SUB_H;

    const cx = (i: number) => PAD_L + slot * (i + 0.5);

    // 副图数据（MACD 用独立第二副图）
    const macd = sub === 'macd' ? calcMACD(rows) : null;
    const kdj = sub === 'kdj' ? calcKDJ(rows) : null;
    const rsi = sub === 'rsi' ? calcRSI(rows) : null;
    let subLo = 0;
    let subHi = 1;
    if (macd) {
      const vals = [...macd.dif, ...macd.dea, ...macd.bar].filter((v): v is number => v != null);
      if (vals.length) { subLo = Math.min(...vals); subHi = Math.max(...vals); }
    } else if (kdj) {
      const vals = [...kdj.k, ...kdj.d, ...kdj.j].filter((v): v is number => v != null);
      if (vals.length) { subLo = Math.min(...vals); subHi = Math.max(...vals); }
    } else if (rsi) {
      subLo = 0;
      subHi = 100;
    }
    const sy = (v: number) => subBottom - ((v - subLo) / (subHi - subLo || 1)) * SUB_H;

    const candles = rows.map((r, i) => {
      const up = r.close >= r.open;
      const prev = i > 0 ? rows[i - 1].close : r.open;
      const pct = prev ? ((r.close - prev) / prev) * 100 : 0;
      return {
        i, r, up, pct,
        color: changeColor(pct),
        x: cx(i),
        bodyTop: y(Math.max(r.open, r.close)),
        bodyBottom: y(Math.min(r.open, r.close)),
        wickTop: y(r.high),
        wickBottom: y(r.low),
        volTop: vy(r.volume),
      };
    });

    const linePath = (arr: (number | null)[]) => {
      const pts: string[] = [];
      arr.forEach((v, i) => { if (v != null) pts.push(`${cx(i).toFixed(1)},${y(v).toFixed(1)}`); });
      return pts.length ? 'M' + pts.join(' L') : '';
    };
    const subPath = (arr: (number | null)[]) => {
      const pts: string[] = [];
      arr.forEach((v, i) => { if (v != null) pts.push(`${cx(i).toFixed(1)},${sy(v).toFixed(1)}`); });
      return pts.length ? 'M' + pts.join(' L') : '';
    };

    const maPaths = showMa
      ? (['ma5', 'ma10', 'ma20'] as const).map((key) => ({ key, d: linePath(ma[key]), color: MA_COLORS[key] }))
      : [];
    const bollPaths = showBoll
      ? [
          { key: 'boll-up', d: linePath(boll.upper), color: '#94a3b8' },
          { key: 'boll-mid', d: linePath(boll.mid), color: '#64748b' },
          { key: 'boll-low', d: linePath(boll.lower), color: '#94a3b8' },
        ]
      : [];

    const gridCount = 4;
    const gridLines = Array.from({ length: gridCount + 1 }, (_, k) => {
      const p = lo + ((hi - lo) * k) / gridCount;
      return { y: y(p), value: p };
    });

    const step = Math.max(1, Math.ceil(n / 8));
    const xLabels = rows
      .map((r, i) => (i % step === 0 ? { x: cx(i), text: r.date.slice(5) } : null))
      .filter(Boolean) as { x: number; text: string }[];

    const stats = rangeStats(rows);

    // 买卖点标注（只在价格落在纵轴范围内时画）
    const planLines = [
      plan?.buyLow != null && plan?.buyHigh != null && !plan.buyBlockedByLimitUp
        ? { kind: 'band', from: y(plan.buyLow), to: y(plan.buyHigh), color: PLAN_COLORS.buy, text: `买入区间 ${fmtNum(plan.buyLow)}~${fmtNum(plan.buyHigh)}` }
        : null,
      plan?.stop != null
        ? { kind: 'line', y: y(plan.stop), color: PLAN_COLORS.stop, text: `止损 ${fmtNum(plan.stop)}` }
        : null,
      plan?.target1 != null
        ? { kind: 'line', y: y(plan.target1), color: PLAN_COLORS.target, text: `目标1 ${fmtNum(plan.target1)}` }
        : null,
      plan?.target2 != null
        ? { kind: 'line', y: y(plan.target2), color: PLAN_COLORS.target, text: `目标2 ${fmtNum(plan.target2)}` }
        : null,
    ].filter(Boolean) as { kind: string; y?: number; from?: number; to?: number; color: string; text: string }[];

    return {
      isIntraday: false,
      candles,
      maPaths,
      bollPaths,
      gridLines,
      xLabels,
      slot,
      bodyW,
      subTop,
      subBottom,
      subLo,
      subHi,
      sy,
      macd,
      kdj,
      rsi,
      subPath,
      stats,
      ma,
      boll,
      planLines,
      lastX: cx(n - 1),
      intraday: null,
      // 占位（分时专用）
      pricePath: '',
      avgPath: '',
      priceColor: '#000',
      prevCloseY: null,
      volBars: [] as IntradayVolBar[],
      intradayHead: null,
    };
  }, [rows, intraday, sub, plan, prevClose, showMa, showBoll]);

  if (!view) return <div className="empty">暂无 {intraday ? '分时' : 'K 线'}数据</div>;

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
    const relX = ((e.clientX - rect.left) / rect.width) * W;
    let next: number | null = null;
    if (view.isIntraday) {
      // 分时：x 反推到时间槽（固定轴）
      const slot = Math.round((relX - PAD_L) / ((W - PAD_L - PAD_R) / (INTRADAY_SLOT_COUNT - 1)));
      next = slot >= 0 && slot <= INTRADAY_SLOT_COUNT - 1 ? slot : null;
    } else {
      const idx = Math.floor((relX - PAD_L) / view.slot);
      next = idx >= 0 && idx < rows.length ? idx : null;
    }
    setHover(next);
  };

  const hv = hover != null ? (view.isIntraday ? null : rows[hover]) : null;
  const hvCandle = hover != null && !view.isIntraday ? view.candles[hover] : null;
  const hvIntraday = hover != null && view.isIntraday ? (view.intradayBySlot?.[hover] ?? null) : null;
  const hvMa = hover != null && !view.isIntraday ? view.ma : null;
  const bottomY = view.subBottom + PANEL_GAP;

  return (
    <div className="kline-wrap">
      {view.isIntraday && view.intradayHead && (
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, padding: '2px 6px 0' }}>
          <span style={{ fontSize: 18, fontWeight: 700, color: view.intradayHead.color }}>
            {fmtNum(view.intradayHead.price)}
          </span>
          <span style={{ fontSize: 13, color: view.intradayHead.color }}>
            {formatChange(view.intradayHead.changeVal)}（{formatPct(view.intradayHead.changePct)}%）
          </span>
        </div>
      )}
      <svg viewBox={`0 0 ${W} ${H}`} className="kline-svg" onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        <rect x="0" y="0" width={W} height={H} fill="#ffffff" />

        {view.gridLines.map((g, i) => (
          <g key={i}>
            <line x1={PAD_L} y1={g.y} x2={W - PAD_R} y2={g.y} stroke="#f3f4f6" strokeWidth="1" />
            <text x={PAD_L - 6} y={g.y + 4} fontSize="11" fill="#6b7280" textAnchor="end">{g.value.toFixed(2)}</text>
          </g>
        ))}

        {/* —— 买入区间金色半透明色带 —— */}
        {view.planLines.filter((p) => p.kind === 'band').map((p, i) => (
          <rect key={'band' + i} x={PAD_L} y={p.to!} width={W - PAD_L - PAD_R} height={Math.max(1, p.from! - p.to!)}
            fill={p.color} opacity="0.16" />
        ))}

        {/* 副图：成交量 / MACD / KDJ / RSI */}
        <line x1={PAD_L} y1={view.subBottom} x2={W - PAD_R} y2={view.subBottom} stroke="#e5e7eb" strokeWidth="1" />
        {view.isIntraday
          ? view.volBars.map((c, i) => (
              <rect key={'iv' + i} x={c.x} y={c.volTop}
                width={c.w} height={Math.max(1, view.subBottom - c.volTop)} fill={c.color} opacity="0.75" />
            ))
          : sub === 'vol' &&
            view.candles.map((c) => (
              <rect key={'v' + c.i} x={c.x - view.bodyW / 2} y={view.subTop + (c.volTop - view.subTop)}
                width={view.bodyW} height={Math.max(1, view.subBottom - c.volTop)} fill={c.color} opacity="0.75" />
            ))}
        {!view.isIntraday && sub === 'macd' && view.macd && (
          <>
            {view.candles.map((c) => {
              const b = view.macd!.bar[c.i];
              if (b == null) return null;
              const zero = view.sy(0);
              const yy = view.sy(b);
              return (
                <rect key={'m' + c.i} x={c.x - view.bodyW / 2} y={Math.min(yy, zero)}
                  width={view.bodyW} height={Math.max(1, Math.abs(zero - yy))}
                  fill={b >= 0 ? '#DC2626' : '#16A34A'} opacity="0.7" />
              );
            })}
            <path d={view.subPath(view.macd.dif)} fill="none" stroke="#f59e0b" strokeWidth="1.3" />
            <path d={view.subPath(view.macd.dea)} fill="none" stroke="#3b82f6" strokeWidth="1.3" />
            <text x={PAD_L - 6} y={view.subTop + 12} fontSize="10" fill="#6b7280" textAnchor="end">MACD</text>
          </>
        )}
        {!view.isIntraday && sub === 'kdj' && view.kdj && (
          <>
            <path d={view.subPath(view.kdj.k)} fill="none" stroke="#f59e0b" strokeWidth="1.3" />
            <path d={view.subPath(view.kdj.d)} fill="none" stroke="#3b82f6" strokeWidth="1.3" />
            <path d={view.subPath(view.kdj.j)} fill="none" stroke="#a855f7" strokeWidth="1.2" />
            <text x={PAD_L - 6} y={view.subTop + 12} fontSize="10" fill="#6b7280" textAnchor="end">KDJ</text>
          </>
        )}
        {!view.isIntraday && sub === 'rsi' && view.rsi && (
          <>
            <line x1={PAD_L} y1={view.sy(70)} x2={W - PAD_R} y2={view.sy(70)} stroke="#e5e7eb" strokeDasharray="3 3" />
            <line x1={PAD_L} y1={view.sy(30)} x2={W - PAD_R} y2={view.sy(30)} stroke="#e5e7eb" strokeDasharray="3 3" />
            <path d={view.subPath(view.rsi)} fill="none" stroke="#7c3aed" strokeWidth="1.4" />
            <text x={PAD_L - 6} y={view.subTop + 12} fontSize="10" fill="#6b7280" textAnchor="end">RSI14</text>
          </>
        )}

        {/* 主图：分时（价格线 + 均价线 + 昨收参考线）或 K 线蜡烛 */}
        {view.isIntraday ? (
          <>
            {view.prevCloseY != null && (
              <line x1={PAD_L} y1={view.prevCloseY} x2={W - PAD_R} y2={view.prevCloseY} stroke="#9ca3af" strokeWidth="1" strokeDasharray="5 3" />
            )}
            {view.prevCloseY != null && (
              <text x={W - PAD_R} y={view.prevCloseY - 4} fontSize="11" fill="#6b7280" textAnchor="end">昨收</text>
            )}
            {view.avgPath && <path d={view.avgPath} fill="none" stroke={AVG_COLOR} strokeWidth="1.3" opacity="0.9" />}
            <path d={view.pricePath} fill="none" stroke={view.priceColor} strokeWidth="1.4" />
          </>
        ) : (
          <>
            {view.candles.map((c) => (
              <g key={c.i}>
                <line x1={c.x} y1={c.wickTop} x2={c.x} y2={c.wickBottom} stroke={c.color} strokeWidth="1.2" />
                <rect x={c.x - view.bodyW / 2} y={c.bodyTop} width={view.bodyW}
                  height={Math.max(1.5, c.bodyBottom - c.bodyTop)} fill={c.color} />
              </g>
            ))}
            {view.maPaths.map((p) => p.d ? <path key={p.key} d={p.d} fill="none" stroke={p.color} strokeWidth="1.4" opacity="0.9" /> : null)}
            {view.bollPaths.map((p) => p.d ? <path key={p.key} d={p.d} fill="none" stroke={p.color} strokeWidth="1.2" opacity="0.8" strokeDasharray="4 2" /> : null)}
          </>
        )}

        {/* —— 止损 / 目标虚线 + 文字标签 —— */}
        {view.planLines.filter((p) => p.kind === 'line').map((p, i) => (
          <g key={'pl' + i}>
            <line x1={PAD_L} y1={p.y!} x2={W - PAD_R} y2={p.y!} stroke={p.color} strokeWidth="1.2" strokeDasharray="6 4" />
            <text x={W - PAD_R} y={p.y! - 4} fontSize="11" fill={p.color} textAnchor="end">{p.text}</text>
          </g>
        ))}

        {/* —— 战法信号图标（末根 K 线上方）—— */}
        {signals.length > 0 && (
          <g onClick={() => setSigOpen(!sigOpen)} style={{ cursor: 'pointer' }}>
            <circle cx={view.lastX} cy={PAD_T + 10} r="9" fill="#f59e0b" />
            <text x={view.lastX} y={PAD_T + 14} fontSize="11" fill="#ffffff" textAnchor="middle" fontWeight="600">
              {signals.length}
            </text>
            <text x={view.lastX} y={PAD_T + 34} fontSize="10" fill="#b45309" textAnchor="middle">战法信号</text>
          </g>
        )}

        {hover != null && (
          <line x1={view.isIntraday ? intradaySlotX(hover) : PAD_L + view.slot * (hover + 0.5)} y1={PAD_T}
            x2={view.isIntraday ? intradaySlotX(hover) : PAD_L + view.slot * (hover + 0.5)} y2={view.subBottom}
            stroke="#9ca3af" strokeWidth="1" strokeDasharray="4 3" />
        )}

        {view.xLabels.map((l, i) => (
          <text key={i} x={l.x} y={bottomY + 12} fontSize="11" fill="#6b7280" textAnchor="middle">{l.text}</text>
        ))}
      </svg>

      {view.isIntraday && (
        <div className="kline-legend">
          <span>红涨绿跌，幅度越大颜色越深</span>
          <span>
            <i style={{ background: view.priceColor }} /> 分时
            <i style={{ background: AVG_COLOR }} /> 均价
          </span>
          <span>价格/均价线由前端基于分时序列绘制；昨收虚线为当日基准</span>
        </div>
      )}
      {!view.isIntraday && (
        <div className="kline-legend">
          <span>红涨绿跌，幅度越大颜色越深</span>
          {showMa && (
            <span>
              <i style={{ background: MA_COLORS.ma5 }} /> MA5
              <i style={{ background: MA_COLORS.ma10 }} /> MA10
              <i style={{ background: MA_COLORS.ma20 }} /> MA20
            </span>
          )}
          {showBoll && <span><i style={{ background: '#64748b' }} /> BOLL(20,2)</span>}
          {plan && (
            <span>
              <i style={{ background: PLAN_COLORS.buy }} /> 买入区间
              <i style={{ background: PLAN_COLORS.stop }} /> 止损
              <i style={{ background: PLAN_COLORS.target }} /> 目标
            </span>
          )}
          <span>MA / MACD / KDJ / RSI / BOLL 均由前端基于真实 K 线自算，非上游直供</span>
        </div>
      )}

      {/* 战法信号详情（点击图标展开） */}
      {sigOpen && signals.length > 0 && (
        <div className="sig-box">
          <div className="sig-head">命中战法与触发原因</div>
          {signals.map((s) => (
            <div key={s.id} className="sig-item">
              <strong>{s.name}</strong>
              <ul>
                {s.conds.map((c) => (
                  <li key={c.key} className={c.pass ? 'pass' : 'fail'}>
                    {c.pass ? '✓' : c.na ? '–' : '✕'} {c.key}：{c.detail}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      {hv && (
        <div className="kline-tip">
          <strong>{hv.date}</strong>
          <span>开 {fmtNum(hv.open)}</span>
          <span>高 {fmtNum(hv.high)}</span>
          <span>低 {fmtNum(hv.low)}</span>
          <span>收 {fmtNum(hv.close)}</span>
          {hvCandle && (
            <span>
              涨跌{' '}
              <span style={{ color: changeColor(hvCandle.pct) }}>
                {formatPct(hvCandle.pct)}%
              </span>
            </span>
          )}
          <span>量 {fmtVolume(hv.volume)}</span>
          {hvMa && (
            <span className="muted">
              MA5 {fmtNum(hvMa.ma5[hover!] ?? null)} / MA10 {fmtNum(hvMa.ma10[hover!] ?? null)} / MA20{' '}
              {fmtNum(hvMa.ma20[hover!] ?? null)}
            </span>
          )}
        </div>
      )}

      {hvIntraday && (
        <div className="kline-tip">
          <strong>{hvIntraday.time}</strong>
          <span>价 {fmtNum(hvIntraday.price)}</span>
          <span>量 {fmtVolume(hvIntraday.vol)}</span>
          <span>累计 {fmtVolume(hvIntraday.cumVolume)}</span>
          {prevClose != null && (
            <span>
              涨跌{' '}
              <span style={{ color: changeColor(hvIntraday.price - prevClose) }}>
                {formatPct(((hvIntraday.price - prevClose) / prevClose) * 100)}%
              </span>
            </span>
          )}
        </div>
      )}

      {view.stats && (
        <div className="kline-stats">
          {view.isIntraday
            ? `当日 ${view.stats.days} 点 · 涨跌 ${formatPct(view.stats.changePct)}% · 最高 ${fmtNum(view.stats.high)} · 最低 ${fmtNum(view.stats.low)} · 累计量 ${fmtVolume(view.stats.volume)}`
            : `区间 ${view.stats.days} 根 · 涨跌 ${formatPct(view.stats.changePct)}% · 最高 ${fmtNum(view.stats.high)} · 最低 ${fmtNum(view.stats.low)} · 累计量 ${fmtVolume(view.stats.volume)}`}
        </div>
      )}
    </div>
  );
}

/** 分时渲染模式下 candles 的占位类型（K 线模式专用） */
interface KlineChartCandle {
  i: number;
  r: KlineRow;
  up: boolean;
  pct: number;
  color: string;
  x: number;
  bodyTop: number;
  bodyBottom: number;
  wickTop: number;
  wickBottom: number;
  volTop: number;
}
