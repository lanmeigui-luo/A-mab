// nav-context.ts —— 翻页导航上下文（纯函数，可离线验收）
export type NavSource = 'trade-table' | 'watchlist' | 'board-cons';
export type NavOwner = 'trade-modal' | 'self';

export interface NavItem {
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

/** 由入口列表构造快照；record 必须能在 items 中找到 */
export function buildNavContext(
  source: NavSource,
  rows: NavItem[],
  current: NavItem,
  owner: NavOwner,
): NavContext | null {
  const idx = rows.findIndex((r) => r.fullCode === current.fullCode);
  if (idx < 0) return null;
  return {
    id: source + ':' + Date.now() + ':' + idx,
    source,
    items: rows.map((r) => ({ fullCode: r.fullCode, name: r.name })),
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
