import { HardHat, RotateCw, ScrollText } from 'lucide-react';
import type { LensEngine } from '../core/engine';
import { isFinished, recentBatches } from '../core/selectors';
import type { Auditor, BatchReceipt, StoreState } from '../core/types';
import { batchStatusLabel, dateTime, evidenceKindLabel } from './format';
import { Badge } from './Badge';

const typeLabel: Record<string, string> = {
  'scan-component': '扫描组件',
  'save-evidence': '保存材料',
  'publish-baseline': '发布基线',
  'resolve-dispute': '处理争议',
};

const statusTone: Record<string, 'teal' | 'orange' | 'red' | 'blue' | 'gray' | 'purple' | 'green'> = {
  running: 'blue',
  partial: 'orange',
  committed: 'teal',
  failed: 'red',
  disputed: 'purple',
};

function BatchCard({
  batch,
  engine,
  notify,
}: {
  batch: BatchReceipt;
  engine: LensEngine;
  notify: (msg: string, tone?: 'ok' | 'error' | 'info') => void;
}) {
  const unfinished = batch.items.filter((i) => i.status === 'pending' || i.status === 'failed');
  const done = batch.items.filter((i) => i.status === 'done').length;
  return (
    <div className={`batch-card ${isFinished(batch) ? '' : 'unfinished'}`}>
      <div className="batch-top">
        <div>
          <b>{batch.label}</b>
          <small className="mono">{batch.id}</small>
        </div>
        <Badge tone={statusTone[batch.status]}>{batchStatusLabel[batch.status]}</Badge>
      </div>
      <p className="small muted">
        {batch.startedBy} 发起 · {dateTime(batch.startedAt)}
        {batch.finishedAt ? ` → ${dateTime(batch.finishedAt)}` : ''} · 修订 {batch.baseRev}
        {batch.finalRev ? ` → ${batch.finalRev}` : ''}
      </p>
      <div className="batch-progress">
        <div className="bar">
          <div className="fill" style={{ width: `${(done / batch.items.length) * 100}%` }} />
        </div>
        <span className="small mono">{done}/{batch.items.length}</span>
      </div>
      <div className="batch-items">
        {batch.items.map((it) => (
          <span key={it.id} className={`chip chip-${it.status}`} title={it.error || typeLabel[it.type]}>
            {it.type === 'save-evidence'
              ? evidenceKindLabel[(it.payload as { kind?: string }).kind ?? ''] || '材料'
              : it.componentId?.split(':').slice(1).join(':') || typeLabel[it.type]}
            {it.attempts > 1 ? ` ×${it.attempts}` : ''}
          </span>
        ))}
      </div>
      {it_unfinishedHint()}
      <div className="batch-foot">
        {unfinished.length > 0 && batch.status !== 'disputed' && (
          <button
            className="primary"
            onClick={() => {
              const res = engine.retryUnfinished(batch.id);
              const r = res[0];
              if (r?.failure) notify(`重试仍失败：${r.failure}（未完成项完整保留）`, 'error');
              else notify(`批次已恢复：剩余 ${r?.stillPending ?? 0} 项未完成`, r?.stillPending ? 'error' : 'ok');
            }}
          >
            <RotateCw size={13} /> 从完整批次继续（重试未完成 {unfinished.length} 项）
          </button>
        )}
        {batch.disputeId && <Badge tone="purple">争议 {batch.disputeId}</Badge>}
      </div>
    </div>
  );

  function it_unfinishedHint() {
    const errs = batch.items.filter((i) => i.error && i.status !== 'conflict').slice(0, 2);
    if (errs.length === 0) return null;
    return (
      <p className="small red-text">
        <HardHat size={12} /> {errs[0].error}
      </p>
    );
  }
}

export function RecoveryCenter({
  state,
  engine,
  notify,
}: {
  state: StoreState;
  engine: LensEngine;
  auditor: Auditor;
  notify: (msg: string, tone?: 'ok' | 'error' | 'info') => void;
}) {
  const batches = recentBatches(state, 30);
  const recoverable = batches.filter((b) => !isFinished(b) && b.items.some((i) => i.status === 'pending' || i.status === 'failed'));

  return (
    <div className="card recovery">
      <div className="pane-head">
        <div>
          <h2><ScrollText size={16} /> 批次回执与恢复中心</h2>
          <p>每一批操作（扫描、材料、基线发布、争议处理）都有完整回执；落盘失败后从完整批次继续，仅重试未完成项</p>
        </div>
        {recoverable.length > 0 && (
          <button
            className="primary"
            onClick={() => {
              const rs = engine.retryAll();
              const pending = rs.reduce((a, r) => a + r.stillPending, 0);
              notify(pending === 0 ? '全部未完成批次已恢复提交' : `仍有 ${pending} 项未完成`, pending === 0 ? 'ok' : 'error');
            }}
          >
            <RotateCw size={13} /> 全部继续（{recoverable.length} 个批次）
          </button>
        )}
      </div>
      {batches.length === 0 && <p className="muted small empty-block">尚无批次。导入锁文件或保存材料后，回执会出现在这里。</p>}
      <div className="batch-grid">
        {batches.map((b) => (
          <BatchCard key={b.id} batch={b} engine={engine} notify={notify} />
        ))}
      </div>
    </div>
  );
}
