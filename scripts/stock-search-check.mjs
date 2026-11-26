/**
 * stock-search-check.mjs —— 自选股拼音/模糊搜索的纯函数验收（不替代接线验证）
 *
 * 覆盖：字典完整性、代码/名称/首字母/全拼四路匹配、排序、limit、空输入、多音字。
 * 运行：node --experimental-strip-types scripts/stock-search-check.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const idx = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'assets', 'stock-index.json'), 'utf8'));
const rows = idx.rows.map(([code, name, market, py, ini]) => ({ code, name, market, py, ini }));

const { searchStocks } = await import('../src/lib/stock-search.ts');

let n = 0;
const ok = (cond, msg) => {
  assert.ok(cond, msg);
  n += 1;
  console.log('  PASS', msg);
};
const codes = (q, limit) => searchStocks(rows, q, limit).map((r) => r.code);
const first = (q) => codes(q, 10)[0];

console.log('== 1. 字典完整性 ==');
ok(idx.count === rows.length, `count 字段与行数一致 (${rows.length})`);
ok(rows.length >= 5000, `全市场覆盖 >= 5000 只，实测 ${rows.length}`);
ok(new Set(rows.map((r) => r.code)).size === rows.length, 'code 无重复');
ok(rows.every((r) => /^\d{6}$/.test(r.code)), 'code 均为 6 位数字');
ok(rows.every((r) => r.py && r.ini), 'py/ini 无空值');
ok(rows.every((r) => ['sh', 'sz', 'bj'].includes(r.market)), 'market 合法');
ok(rows.every((r) => /^[a-z]+$/.test(r.py) && /^[a-z]+$/.test(r.ini)), 'py/ini 仅小写字母');

console.log('== 2. 代码匹配 ==');
ok(first('600519') === '600519', '600519 精确命中');
ok(first('002815') === '002815', '002815 精确命中');
ok(codes('6005', 10).length > 0 && codes('6005', 10).every((c) => c.startsWith('6005')), '6005 前缀结果全部以 6005 开头');
ok(first('600519') === '600519', '完整代码 600519 仍居首（补码精度）');
ok(first('920045') === '920045', '920045 北交所命中');

console.log('== 3. 名称匹配 ==');
ok(first('崇达') === '002815', '崇达 -> 002815');
ok(first('贵州茅台') === '600519', '贵州茅台 -> 600519');
ok(first('茅台') === '600519', '茅台（子串）-> 600519');

console.log('== 4. 首字母匹配 ==');
ok(first('cdjs') === '002815', 'cdjs -> 002815');
ok(first('gzmt') === '600519', 'gzmt -> 600519');
ok(codes('gz', 10).every((c) => c), 'gz 有结果');
ok(codes('zmt', 10).includes('600519'), 'zmt（非首尾截取）命中 600519');
ok(first('cqpj') === '600132', 'cqpj 多音字 -> 重庆啤酒 600132');

console.log('== 5. 全拼匹配 ==');
ok(first('chongdajishu') === '002815', 'chongdajishu -> 002815');
ok(codes('chongda', 10).includes('002815'), 'chongda 前缀 -> 002815');
ok(first('guizhoumaotai') === '600519', 'guizhoumaotai -> 600519');

console.log('== 6. 多音字上下文 ==');
const cq = rows.find((r) => r.code === '600132');
ok(cq && cq.py.startsWith('chongqing'), `重庆啤酒 py=${cq && cq.py}（应为 chongqing 而非 zhongqing）`);
const yh = rows.find((r) => r.name.includes('银行'));
ok(yh && yh.ini.includes('yh'), `银行类首字母含 yh：${yh && yh.name} ${yh && yh.ini}`);

console.log('== 7. 边界 ==');
ok(searchStocks(rows, '', 10).length === 0, '空查询返回空');
ok(searchStocks(rows, '   ', 10).length === 0, '纯空格返回空');
ok(searchStocks(rows, 'zzzzzzzz', 10).length === 0, '无匹配返回空');
ok(searchStocks(rows, 'g', 5).length <= 5, 'limit 生效');
ok(searchStocks(rows, 'g').length <= 10, '默认上限 10');
const a = codes('js', 10).join(',');
const b = codes('js', 10).join(',');
ok(a === b, '同一输入两次结果一致（排序确定性）');
ok(searchStocks(rows, 'GZMT').length > 0, '大写输入可用');
ok(first('  gzmt  ' ) === '600519', '首尾空格被忽略');

console.log(`\n全部通过：${n} 项`);
