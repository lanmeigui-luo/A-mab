// nav-context.ts —— 翻页导航上下文（纯函数，可离线验收）
export type NavSource = 'trade-table' | 'watchlist' | 'board-cons';
export type NavOwner = 'trade-modal' | 'self';

export interface NavItem {
  /** 行唯一标识：交易明细用记录 id，自选股/成分股用 fullCode。
   *  同一只票多条交易记录时 fullCode 相同，必须用 id 才能定位到具体第几条。 */
  id: string;
  fullCode: string;
  name: string;
}

export interface NavContext {
  id: string;
  source: NavSource;
  /** 打开瞬间的行顺序快照（完整筛选结果，非当前分页），不去重 */
  items: NavItem[];
  index: number;
  owner: NavOwner;
}

/** 由入口列表构造快照；按 current.id 定位（不是 fullCode，同票多记录需区分） */
export function buildNavContext(
  source: NavSource,
  rows: NavItem[],
  current: NavItem,
  owner: NavOwner,
): NavContext | null {
  const idx = rows.findIndex((r) => r.id === current.id);
  if (idx < 0) return null;
  return {
    id: source + ':' + Date.now() + ':' + idx,
    source,
    items: rows.map((r) => ({ id: r.id, fullCode: r.fullCode, name: r.name })),
    index: idx,
    owner,
  };
}

/** 翻页；越界返回 null（首/末置灰由调用方用 canPrev/canNext 判断） */
export function stepNav(nav: NavContext, delta: number): NavContext | null {
  const next = nav.index + delta;
  if (next < 0 || next >= nav.items.length) return null;
  return { ...nav, index: next };
}

export function canPrev(nav: NavContext | null | undefined): boolean {
  return !!nav && nav.index > 0;
}

export function canNext(nav: NavContext | null | undefined): boolean {
  return !!nav && nav.index < nav.items.length - 1;
}

export function currentItem(nav: NavContext | null | undefined): NavItem | null {
  return nav ? nav.items[nav.index] ?? null : null;
}

/** 箭头归属：弹窗内打开 → trade-modal；其余 → self */
export function ownerFor(inModal: boolean): NavOwner {
  return inModal ? 'trade-modal' : 'self';
}
