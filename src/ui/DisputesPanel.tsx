import { GitMerge, Trash2 } from 'lucide-react';
import type { LensEngine } from '../core/engine';
import { openDisputes } from '../core/selectors';
import type { Auditor, StoreState } from '../core/types';
import { dateTime, evidenceKindLabel } from './format';
import { Badge } from './Badge';

export function DisputesPanel({
  state,
  engine,
  auditor,
  notify,
}: {
  state: StoreState;
  engine: LensEngine;
  auditor: Auditor;
  notify: (msg: string, tone?: 'ok' | 'error' | 'info') => void;
}) {
  const open = openDisputes(state);
  const history = Object.values(state.disputes)
    .filter((d) => d.status !== 'open')
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, 6);

  const resolve = (id: string, action: 'merge' | 'discard') => {
    const res = engine.resolveDispute(
      id,
      action,
      auditor,
      action === 'merge' ? '人工合并：后到材料补入证据链' : '人工舍弃：以先到者材料为准',
    );
    if (!res) {
      notify('争议已被其他标签处理', 'error');
    } else if (res.failure) {
      notify(`处理失败：${res.failure}`, 'error');
    } else {
      notify(action === 'merge' ? '后到者材料已合并入链' : '后到者材料已舍弃，先到者材料保留', 'ok');
    }
  };

  return (
    <div className="card disputes">
      <div className="pane-head">
        <div>
          <h2>争议清单</h2>
          <p>两标签同时保存同一批次时，先到者材料保留为有效证据，后到者材料原样留存于此</p>
        </div>
        {open.length > 0 && <Badge tone="red">{open.length} 待处理</Badge>}
      </div>

      {open.length === 0 && history.length === 0 && (
        <p className="muted small empty-block">暂无争议。让两位审计员在不同标签同时为同一组件保存材料即可复现。</p>
      )}

      {open.map((d) => (
        <div key={d.id} className="dispute-item open">
          <div className="dispute-top">
            <b>{d.laterLabel}</b>
            <Badge tone="red">待人工处理</Badge>
          </div>
          <p className="small">{d.reason}</p>
          <p className="small">
            先到者 <b>{d.earlierBy}</b> 的材料保留有效；后到者 <b>{d.laterBy}</b> 的{' '}
            {d.laterItems.length} 份材料未覆盖任何数据：
          </p>
          <ul className="later-items">
            {d.laterItems.map((it) => {
              const p = it.payload as { title?: string; kind?: string; detail?: string };
              return (
                <li key={it.id}>
                  <Badge tone="purple">{p.kind ? evidenceKindLabel[p.kind] : it.type}</Badge>
                  <b>{p.title}</b>
                  <span className="muted">{p.detail}</span>
                </li>
              );
            })}
          </ul>
          <p className="small muted">组件：{d.componentIds.join('，')} · 发生于 {dateTime(d.createdAt)}</p>
          <div className="dispute-actions">
            <button className="primary" onClick={() => resolve(d.id, 'merge')}><GitMerge size={13} /> 合并后到材料</button>
            <button className="outline danger-text" onClick={() => resolve(d.id, 'discard')}><Trash2 size={13} /> 舍弃</button>
          </div>
        </div>
      ))}

      {history.length > 0 && (
        <>
          <h3 className="sub">已处理</h3>
          {history.map((d) => (
            <div key={d.id} className="dispute-item closed">
              <div className="dispute-top">
                <b>{d.laterLabel}</b>
                <Badge tone={d.status === 'merged' ? 'teal' : 'gray'}>
                  {d.status === 'merged' ? '已合并' : '已舍弃'}
                </Badge>
              </div>
              <p className="small muted">
                {d.earlierBy} 先到 / {d.laterBy} 后到 · {d.resolvedBy} 处理于 {d.resolvedAt ? dateTime(d.resolvedAt) : ''}
              </p>
              {d.resolutionNote && <p className="small">{d.resolutionNote}</p>}
            </div>
          ))}
        </>
      )}
    </div>
  );
}
