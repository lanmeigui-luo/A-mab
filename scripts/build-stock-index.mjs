/**
 * build-stock-index.mjs —— 生成前端本地股票字典（代码 / 名称 / 全拼 / 首字母）
 *
 * 数据源：新浪全市场排行（Market_Center.getHQNodeData, node=hs_a）
 *   与 server/sources/sina_rank.mjs 同一通道，本机已实测可用：
 *   56 页 × 100 条 = 5580 只（2026-11-26 实测），单页 0.23~0.34s。
 *
 * 拼音：pinyin-pro，仅在「生成本文件时」使用，运行时前端只读 stock-index.json。
 *   优先从项目 node_modules 解析；也可用环境变量 PINYIN_PRO_PATH 指定已装副本，
 *   例如：PINYIN_PRO_PATH=C:\path\to\node_modules\pinyin-pro
 *
 * 用法：
 *   node scripts/build-stock-index.mjs
 *   产出：src/assets/stock-index.json
 *
 * 口径说明：
 *   - market 以新浪 symbol 前缀为准；缺失时回落到与 src/lib/full-code.ts 一致的规则
 *     （920 段必须先于「9 开头 → sh」判断，否则北交所会被拼成 sh）。
 *   - 输出为紧凑数组格式，控制打包体积：[code, name, market, py, ini]
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'src', 'assets', 'stock-index.json');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PER_PAGE = 100;
const CONCURRENCY = 6;
const MAX_PAGE = 90;

function loadPinyin() {
  const require = createRequire(import.meta.url);
  const candidates = ['pinyin-pro'];
  if (process.env.PINYIN_PRO_PATH) candidates.push(process.env.PINYIN_PRO_PATH);
  for (const c of candidates) {
    try {
      return require(c).pinyin;
    } catch {
      /* try next */
    }
  }
  console.error(
    '[FATAL] 缺少 pinyin-pro。二选一：\n' +
      '  1) npm i -D pinyin-pro\n' +
      '  2) PINYIN_PRO_PATH=<已装 pinyin-pro 的目录> node scripts/build-stock-index.mjs',
  );
  process.exit(1);
}

const pinyin = loadPinyin();

/** 与 src/lib/full-code.ts 同一口径：920 最先判断 */
function inferMarket(code, symbol) {
  const s = String(symbol || '');
  if (s.startsWith('sh')) return 'sh';
  if (s.startsWith('sz')) return 'sz';
  if (s.startsWith('bj')) return 'bj';
  const c = String(code);
  if (c.startsWith('920')) return 'bj';
  if (c.startsWith('4') || c.startsWith('8')) return 'bj';
  if (c.startsWith('6') || c.startsWith('9')) return 'sh';
  return 'sz';
}

async function fetchPage(page) {
  const url =
    'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData' +
    `?page=${page}&num=${PER_PAGE}&sort=code&asc=1&node=hs_a&symbol=&_s_r_a=page`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Referer: 'https://vip.stock.finance.sina.com.cn/' },
      signal: ctrl.signal,
    });
    const txt = await res.text();
    if (!txt || txt.trim() === 'null') return [];
    return JSON.parse(txt);
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const t0 = Date.now();
  const seen = new Map();
  let page = 1;
  let emptyStreak = 0;

  while (page <= MAX_PAGE && emptyStreak < 2) {
    const batch = [];
    for (let i = 0; i < CONCURRENCY && page + i <= MAX_PAGE; i += 1) batch.push(page + i);
    const results = await Promise.all(
      batch.map((p) =>
        fetchPage(p).catch((e) => {
          console.warn(`  page ${p} 失败：${e.message}`);
          return [];
        }),
      ),
    );
    for (const rows of results) {
      if (!Array.isArray(rows) || rows.length === 0) {
        emptyStreak += 1;
        continue;
      }
      emptyStreak = 0;
      for (const r of rows) {
        const code = String(r.code || '').trim();
        const name = String(r.name || '').trim();
        if (!/^\d{6}$/.test(code) || !name) continue;
        if (seen.has(code)) continue;
        seen.set(code, { code, name, market: inferMarket(code, r.symbol) });
      }
    }
    page += batch.length;
  }

  const list = [...seen.values()].sort((a, b) => (a.code < b.code ? -1 : 1));
  const rows = [];
  const noPinyin = [];
  for (const s of list) {
    // 拼音只在「规范名」上算：全角转半角、去空格、去 * / 符号，避免 万 科Ａ / *ST美丽 产生 "w kａ"、"*stml"
    const clean = s.name
      .normalize('NFKC')
      .replace(/\s+/g, '')
      .replace(/[^0-9a-zA-Z\u4e00-\u9fff]/g, '');
    const full = pinyin(clean, { toneType: 'none', type: 'array', v: true }).join('').toLowerCase();
    const ini = pinyin(clean, { pattern: 'first', toneType: 'none', type: 'array', v: true }).join('').toLowerCase();
    if (!full || !ini) noPinyin.push(s.name);
    rows.push([s.code, s.name, s.market, full || s.code, ini || s.code]);
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const payload = {
    builtAt: new Date().toISOString(),
    source: 'sina-rank:hs_a',
    count: rows.length,
    rows,
  };
  fs.writeFileSync(OUT, JSON.stringify(payload), 'utf8');

  const bytes = fs.statSync(OUT).size;
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[done] ${rows.length} 只 / ${(bytes / 1024).toFixed(1)} KB / ${elapsed}s -> ${OUT}`);
  console.log(`[pinyin] 无拼音条目 ${noPinyin.length} ${noPinyin.slice(0, 5).join(',')}`);
  const byMarket = rows.reduce((m, r) => ((m[r[2]] = (m[r[2]] || 0) + 1), m), {});
  console.log('[market]', byMarket);
  for (const probe of ['002815', '600519', '920045']) {
    const hit = rows.find((r) => r[0] === probe);
    console.log(`[probe] ${probe} ->`, hit ? hit.join(' | ') : 'MISSING');
  }
}

main().catch((e) => {
  console.error('[FATAL]', e);
  process.exit(1);
});
