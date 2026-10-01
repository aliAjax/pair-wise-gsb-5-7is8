import { useMemo, useState } from 'react';
import { AlertTriangle, Check, FileCode2, Search } from 'lucide-react';
import type { LensEngine } from '../core/engine';
import type { Auditor, StoreState } from '../core/types';
import { buildViews } from '../core/selectors';
import { decisionLabel } from './format';
import { Badge } from './Badge';

const licenseColors: Record<string, string> = {
  MIT: '#35b995',
  'BSD-3-Clause': '#6d9ee8',
  'BSD-2-Clause': '#6d9ee8',
  'Apache-2.0': '#b18ee4',
  'GPL-2.0': '#ec8c75',
  'GPL-3.0': '#ec8c75',
  'AGPL-3.0': '#e0635f',
  'SSPL-1.0': '#e0635f',
  ISC: '#35b995',
  'MPL-2.0': '#e0a94f',
  'LGPL-2.1': '#e0a94f',
  'BUSL-1.1': '#e0a94f',
  UNKNOWN: '#9aa7ab',
};

const validityInfo = {
  fresh: { label: '裁决有效', tone: 'green' as const, icon: <Check size={12} /> },
  'stale-fingerprint': { label: '指纹已变·待重新确认', tone: 'red' as const, icon: <AlertTriangle size={12} /> },
  'stale-baseline': { label: '基线已更新·待重新确认', tone: 'orange' as const, icon: <AlertTriangle size={12} /> },
  'stale-legacy': { label: '旧数据迁移·待重新确认', tone: 'orange' as const, icon: <AlertTriangle size={12} /> },
  missing: { label: '尚未裁决', tone: 'gray' as const, icon: <AlertTriangle size={12} /> },
};

const filters = [
  { key: '全部', label: '全部' },
  { key: 'attention', label: '待确认' },
  { key: 'approved', label: '已通过' },
  { key: 'rejected', label: '已拒绝' },
];

export function ComponentList({
  state,
  engine,
  auditor,
  selectedId,
  onSelect,
  pendingIds,
}: {
  state: StoreState;
  engine: LensEngine;
  auditor: Auditor;
  selectedId: string | null;
  onSelect: (id: string) => void;
  pendingIds: Set<string>;
}) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('全部');

  const views = useMemo(() => buildViews(state, { pendingComponentIds: pendingIds }), [state, pendingIds]);
  const filtered = views.filter((v) => {
    if (query && !`${v.component.name}${v.component.license}`.toLowerCase().includes(query.toLowerCase())) return false;
    if (filter === 'attention') return v.validity !== 'fresh' || v.pending;
    if (filter === 'approved') return v.verdict?.decision === 'approved' && v.validity === 'fresh';
    if (filter === 'rejected') return (v.verdict?.decision === 'rejected' && v.validity === 'fresh') || v.suggestion.decision === 'rejected';
    return true;
  });

  const decide = (id: string, decision: 'approved' | 'review' | 'rejected') => {
    const noteMap = { approved: '人工确认：符合发布要求', review: '标记为待复核', rejected: '人工裁决：不予通过' };
    engine.decide(id, decision, noteMap[decision], auditor);
  };

  return (
    <div className="card table-pane">
      <div className="pane-head">
        <div>
          <h2>依赖清单</h2>
          <p>指纹或基线变化后，旧裁决自动转为待重新确认</p>
        </div>
        <div className="tools">
          <div className="search">
            <Search size={14} />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索组件/许可证" />
          </div>
          <select value={filter} onChange={(e) => setFilter(e.target.value)}>
            {filters.map((f) => (
              <option key={f.key} value={f.key}>{f.label}</option>
            ))}
          </select>
        </div>
      </div>
      <div className="table">
        <div className="tr th">
          <span>组件</span><span>版本</span><span>许可证</span><span>覆盖材料</span><span>裁决状态</span><span />
        </div>
        {filtered.length === 0 && <div className="empty-row">暂无依赖 — 请先导入锁文件</div>}
        {filtered.map((v) => {
          const c = v.component;
          const color = licenseColors[c.license] ?? '#9aa7ab';
          const vi = validityInfo[v.validity];
          return (
            <div
              key={c.id}
              className={`tr ${c.id === selectedId ? 'selected' : ''} ${v.pending ? 'pending-row' : ''}`}
              onClick={() => onSelect(c.id)}
            >
              <span className="dep-name">
                <span className="pkg-dot" style={{ background: color }} /> {c.name}
                {v.pending && <em className="scan-tag">扫描中</em>}
              </span>
              <span className="muted mono">{c.version}</span>
              <span>
                <i className="license" style={{ color, background: `${color}18` }}>{c.license}</i>
              </span>
              <span>
                {v.covers.length > 0 ? (
                  <Badge tone="purple">{v.covers[0].kind === 'commercial-license' ? '商业授权' : '豁免'} {v.covers.length > 1 ? `×${v.covers.length}` : ''}</Badge>
                ) : (
                  <span className="muted">—</span>
                )}
              </span>
              <span className={`validity validity-${vi.tone}`}>{vi.icon} {vi.label}</span>
              <span className="row-actions" onClick={(e) => e.stopPropagation()}>
                <button className="mini ok" title="裁决通过" onClick={() => decide(c.id, 'approved')}><Check size={13} /></button>
                <button className="mini danger" title="裁决拒绝" onClick={() => decide(c.id, 'rejected')}><AlertTriangle size={13} /></button>
              </span>
            </div>
          );
        })}
      </div>
      <div className="table-foot">
        <FileCode2 size={13} />
        共 {views.length} 个组件 · 待确认 {views.filter((v) => v.validity !== 'fresh').length} · 当前基线 v{state.baseline.version}
        {selectedId && (() => {
          const v = views.find((x) => x.component.id === selectedId);
          return v?.verdict ? <span className="foot-verdict">最近裁决：{decisionLabel[v.verdict.decision]} · {v.verdict.decidedBy}</span> : null;
        })()}
      </div>
    </div>
  );
}
