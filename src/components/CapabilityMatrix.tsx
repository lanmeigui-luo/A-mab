import { useMemo, useState } from 'react';
import { usePolling } from '@/hooks/usePolling';
import { marketApi, type CapabilityMatrixData as Matrix } from '@/services/market';
import { DASH } from '@/lib/format';

const STATUS_LABEL: Record<string, { text: string; cls: string }> = {
  available: { text: '主源直供', cls: 'st-ok' },
  derived: { text: '可计算', cls: 'st-derive' },
  fallback: { text: '需补充源', cls: 'st-fallback' },
  notProbed: { text: '未探测', cls: 'st-unknown' },
  notSupported: { text: '不提供', cls: 'st-no' },
};

/**
 * 数据源能力矩阵（需求第四章 / 阶段 0）
 * 目的：让「哪些字段有真实数据、哪些没有」在界面上可查，
 * 避免 UI 展示不存在的字段或用推断值充数。
 */
export function CapabilityMatrix() {
  const resp = usePolling<{ ok: boolean; matrix?: Matrix; reason?: string }>(
    () => marketApi.capability(),
    0,
    [],
  );
  const [category, setCategory] = useState('');
  const matrix = resp.data?.matrix;

  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const f of matrix?.fields ?? []) set.add(f.category);
    return [...set];
  }, [matrix]);

  const rows = useMemo(
    () => (matrix?.fields ?? []).filter((f) => !category || f.category === category),
    [matrix, category],
  );

  if (resp.loading && !matrix) return <div className="empty">加载能力矩阵…</div>;
  if (!matrix) return <div className="alert error">能力矩阵不可用：{resp.data?.reason ?? resp.error ?? '未知'}</div>;

  return (
    <section className="panel">
      <header className="panel-head">
        <h2>数据源能力矩阵</h2>
        <span className="muted">阶段 0 探测结果 · 标注每个字段的真实来源</span>
        <span className="spacer" />
        <select className="input" style={{ height: 28 }} value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">全部类别</option>
          {categories.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
      </header>

      <div className="toolbar">
        {Object.entries(STATUS_LABEL).map(([k, v]) => (
          <span key={k} className="chip">
            <i className={`st-dot ${v.cls}`} /> {v.text}
          </span>
        ))}
        <span className="spacer" />
        <span className="muted">
          共 {(matrix.fields ?? []).length} 个字段 · 当前显示 {rows.length} 个
        </span>
      </div>

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>类别</th>
              <th>字段</th>
              <th>状态</th>
              <th>来源</th>
              <th>接口 / 路径</th>
              <th>刷新</th>
              <th>延迟</th>
              <th>说明</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((f) => {
              const st = STATUS_LABEL[f.status] ?? { text: f.status, cls: 'st-unknown' };
              return (
                <tr key={f.id}>
                  <td>{f.category}</td>
                  <td>{f.field}</td>
                  <td>
                    <span className={`state ${st.cls}`}>{st.text}</span>
                  </td>
                  <td className="mono muted">{f.primarySource}</td>
                  <td className="cell-endpoint">
                    {f.endpoint ?? DASH}
                    {f.path ? <em>{f.path}</em> : null}
                  </td>
                  <td className="muted">{f.refreshInterval ?? DASH}</td>
                  <td className="muted">{f.latency ?? DASH}</td>
                  <td className="cell-note">{f.note ?? DASH}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="notes">
        <div>
          <strong>数据源</strong>
        </div>
        {(matrix.sources ?? []).map((s) => (
          <div key={s.id}>
            {s.name}（{s.role}）
            {s.installed != null ? ` · 已安装=${s.installed ? '是' : '否'}` : ''}
            {s.reachable != null ? ` · 可达=${s.reachable ? '是' : '否'}` : ''}
            {s.authState ? ` · 授权=${s.authState}` : ''}
            {s.note ? ` · ${s.note}` : ''}
          </div>
        ))}
        {(matrix.environmentFindings ?? []).length > 0 && <div><strong>环境结论</strong></div>}
        {(matrix.environmentFindings ?? []).map((e) => (
          <div key={e.issue}>
            {e.issue} → 影响：{e.impact} → 对策：{e.workaround}
          </div>
        ))}
        {(matrix.unresolved ?? []).length > 0 && <div><strong>待办</strong></div>}
        {(matrix.unresolved ?? []).map((u) => (
          <div key={u}>{u}</div>
        ))}
      </div>
    </section>
  );
}
