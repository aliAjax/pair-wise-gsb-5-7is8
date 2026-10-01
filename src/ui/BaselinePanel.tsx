import { useState } from 'react';
import { GitPullRequestArrow, RotateCcw } from 'lucide-react';
import type { LensEngine } from '../core/engine';
import { findRule } from '../core/policy';
import { DEFAULT_RULES } from '../core/policy';
import type { Auditor, BaselineRule, StoreState, VerdictKind } from '../core/types';
import { dateTime } from './format';
import { Badge } from './Badge';

const options: VerdictKind[] = ['approved', 'review', 'rejected'];
const decisionTone = { approved: 'teal', review: 'orange', rejected: 'red' } as const;

export function BaselinePanel({
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
  const [draft, setDraft] = useState<BaselineRule[]>(() => state.baseline.rules.map((r) => ({ ...r })));
  const [note, setNote] = useState('');
  const dirty = JSON.stringify(draft) !== JSON.stringify(state.baseline.rules);

  const setDecision = (license: string, decision: VerdictKind) => {
    setDraft((ds) => ds.map((r) => (r.license === license ? { ...r, decision } : r)));
  };

  const publish = () => {
    const res = engine.publishBaseline(draft, auditor, note.trim());
    if (res.failure) {
      notify(`基线发布失败：${res.failure}`, 'error');
    } else {
      notify(`策略基线 v${res.version} 已发布，既有裁决全部等待重新确认`, 'ok');
      setNote('');
    }
  };

  const staleCount = Object.values(state.components).filter((c) => {
    const v = state.verdicts[c.id];
    return v && v.baselineVersion !== state.baseline.version;
  }).length;

  return (
    <div className="card baseline-panel">
      <div className="pane-head">
        <div>
          <h2>策略基线 <Badge tone="blue">v{state.baseline.version}</Badge></h2>
          <p>
            {state.baseline.publishedBy} 发布于 {dateTime(state.baseline.publishedAt)} ·
            发布新版本后，旧裁决等待重新确认{staleCount > 0 && <> · 当前 <b className="orange">{staleCount}</b> 条裁决待确认</>}
          </p>
        </div>
        <div className="baseline-actions">
          <button className="outline" title="恢复为默认规则" onClick={() => setDraft(DEFAULT_RULES.map((r) => ({ ...r })))}>
            <RotateCcw size={13} /> 默认规则
          </button>
          <button className="primary" disabled={!dirty} onClick={publish}>
            <GitPullRequestArrow size={13} /> 发布基线 v{state.baseline.version + 1}
          </button>
        </div>
      </div>
      <input className="baseline-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="本次发布说明（可选），如：收购法务收紧 GPL 处理口径" />
      <div className="baseline-list">
        {draft.map((r) => {
          const current = findRule(state.baseline, r.license);
          const changed = current && current.decision !== r.decision;
          return (
            <div key={r.license} className="baseline-row">
              <span className="mono license-name">{r.license}</span>
              <div className="seg">
                {options.map((o) => (
                  <button
                    key={o}
                    className={`seg-btn ${r.decision === o ? `active ${decisionTone[o]}` : ''}`}
                    onClick={() => setDecision(r.license, o)}
                  >
                    {o === 'approved' ? '通过' : o === 'review' ? '复核' : '拒绝'}
                  </button>
                ))}
              </div>
              <span className="muted small rule-note">{r.note}</span>
              {changed && <Badge tone="orange">将变更</Badge>}
            </div>
          );
        })}
      </div>
      {!dirty && <p className="small muted">规则未修改。调整任意许可证的裁决口径后即可发布新版本。</p>}
    </div>
  );
}
