import type { ReactNode } from 'react';
import { useState } from 'react';
import {
  AlertTriangle,
  Check,
  FileCode2,
  FilePlus2,
  Paperclip,
  Scale,
  ShieldCheck,
  Stamp,
  X,
} from 'lucide-react';
import type { LensEngine } from '../core/engine';
import type { Auditor, EvidenceKind, StoreState } from '../core/types';
import { buildViews } from '../core/selectors';
import { decisionLabel, dateTime, evidenceKindLabel } from './format';
import { Badge } from './Badge';

const kindIcon: Record<EvidenceKind, ReactNode> = {
  'commercial-license': <ShieldCheck size={14} />,
  exemption: <Stamp size={14} />,
  'license-text': <FileCode2 size={14} />,
  'purchase-receipt': <Paperclip size={14} />,
};

export function ComponentDetail({
  state,
  engine,
  auditor,
  componentId,
  onClose,
  notify,
}: {
  state: StoreState;
  engine: LensEngine;
  auditor: Auditor;
  componentId: string;
  onClose: () => void;
  notify: (msg: string, tone?: 'ok' | 'error' | 'info') => void;
}) {
  const view = buildViews(state).find((v) => v.component.id === componentId);
  const [kind, setKind] = useState<EvidenceKind>('commercial-license');
  const [title, setTitle] = useState('');
  const [detail, setDetail] = useState('');
  const [contact, setContact] = useState('');
  const [validUntil, setValidUntil] = useState('');
  const [note, setNote] = useState('');

  if (!view) return null;
  const c = view.component;

  const addEvidence = () => {
    if (!title.trim() || !detail.trim()) {
      notify('请填写材料标题与说明', 'error');
      return;
    }
    const res = engine.saveEvidence(
      [
        {
          componentId: c.id,
          kind,
          title: title.trim(),
          detail: detail.trim(),
          contact: contact.trim() || undefined,
          validUntil: validUntil || undefined,
        },
      ],
      auditor,
    );
    if (res.conflict) {
      notify(`后到保存：材料已进入争议清单（${res.disputeId}），未覆盖先到者材料`, 'error');
    } else if (res.failure) {
      notify(`落盘失败：材料已保留在未完成批次，可在恢复中心重试`, 'error');
    } else {
      notify('许可材料已保存并覆盖该组件', 'ok');
      setTitle('');
      setDetail('');
      setContact('');
      setValidUntil('');
    }
  };

  const decide = (decision: 'approved' | 'review' | 'rejected') => {
    const res = engine.decide(c.id, decision, note.trim() || `人工${decisionLabel[decision]}`, auditor);
    if (!res) {
      notify('组件不存在', 'error');
    } else if (res.failure) {
      notify(`裁决保存失败：${res.failure}`, 'error');
    } else {
      notify(`已裁决：${decisionLabel[decision]}（绑定指纹与基线 v${res.verdict.baselineVersion}）`, 'ok');
      setNote('');
    }
  };

  const validityText = {
    fresh: '裁决与当前指纹、基线一致',
    'stale-fingerprint': '包指纹已变化（版本或许可证更新），旧裁决等待重新确认',
    'stale-baseline': `策略基线已更新到 v${state.baseline.version}，旧裁决等待重新确认`,
    'stale-legacy': '来自旧版本数据迁移，需按当前基线重新确认',
    missing: '尚无人工裁决',
  }[view.validity];

  return (
    <div className="card detail">
      <div className="detail-head">
        <div className="detail-icon"><FileCode2 size={18} /></div>
        <div className="detail-title">
          <span>COMPONENT · {c.ecosystem}</span>
          <h2>{c.name}</h2>
          <small className="mono">{c.fingerprint}</small>
        </div>
        <button className="close" onClick={onClose}><X size={16} /></button>
      </div>

      <div className="detail-grid">
        <div><label>版本</label><b className="mono">{c.version}</b></div>
        <div><label>声明许可证</label><b>{c.license}</b></div>
        <div><label>策略基线</label><b>v{state.baseline.version}</b></div>
      </div>

      <div className={`finding ${view.validity === 'fresh' ? 'ok' : view.validity === 'missing' ? 'warn' : 'risk'}`}>
        <div className="finding-icon">
          {view.validity === 'fresh' ? <Check size={15} /> : <AlertTriangle size={15} />}
        </div>
        <div>
          <b>{validityText}</b>
          {view.verdict && (
            <p>
              最近裁决：{decisionLabel[view.verdict.decision]} · {view.verdict.decidedBy} · {dateTime(view.verdict.decidedAt)}
              {view.verdict.legacy && <Badge tone="orange">迁移旧裁决</Badge>}
            </p>
          )}
          <p className="suggestion">
            <Scale size={13} /> 当前建议：<b>{decisionLabel[view.suggestion.decision]}</b> — {view.suggestion.reason}
          </p>
        </div>
      </div>

      <div className="evidence-section">
        <h3><ShieldCheck size={14} /> 覆盖材料（授权与豁免仅覆盖本组件）</h3>
        {view.covers.length === 0 && <p className="muted small">暂无有效商业授权或豁免；基线拒绝项将维持拒绝建议。</p>}
        {view.covers.map((e) => (
          <div key={e.id} className="evidence-item cover">
            <span className="ev-icon">{kindIcon[e.kind]}</span>
            <div>
              <b>{e.title}</b>
              <p>{e.detail}</p>
              <small>
                <Badge tone="purple">{evidenceKindLabel[e.kind]}</Badge>
                {e.contact} · {e.addedBy} · {dateTime(e.addedAt)}
                {e.validUntil ? ` · 有效期至 ${e.validUntil}` : ''}
              </small>
            </div>
          </div>
        ))}
        {view.support.length > 0 && (
          <>
            <h3 className="sub"><FileCode2 size={14} /> 佐证材料</h3>
            {view.support.map((e) => (
              <div key={e.id} className="evidence-item">
                <span className="ev-icon">{kindIcon[e.kind]}</span>
                <div>
                  <b>{e.title}</b>
                  <p>{e.detail}</p>
                  <small>{evidenceKindLabel[e.kind]} · {e.addedBy} · {dateTime(e.addedAt)}</small>
                </div>
              </div>
            ))}
          </>
        )}

        <div className="add-evidence">
          <h4><FilePlus2 size={13} /> 补充许可材料（当前身份：{auditor.name}）</h4>
          <div className="form-row">
            <select value={kind} onChange={(e) => setKind(e.target.value as EvidenceKind)}>
              <option value="commercial-license">商业授权</option>
              <option value="exemption">法务豁免</option>
              <option value="license-text">许可证原文</option>
              <option value="purchase-receipt">采购凭证</option>
            </select>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="材料标题，如 Vendor 商业授权 PO-2026-041" />
          </div>
          <textarea value={detail} onChange={(e) => setDetail(e.target.value)} placeholder="授权范围、编号、适用版本等说明" rows={2} />
          <div className="form-row">
            <input value={contact} onChange={(e) => setContact(e.target.value)} placeholder="授权方/联系人（可选）" />
            <input type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} title="有效期（可选）" />
          </div>
          <button className="primary full" onClick={addEvidence}>保存材料（生成批次回执）</button>        </div>
      </div>

      <div className="decide-box">
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="裁决意见（可选）" />
        <div className="decide-actions">
          <button className="primary ok-btn" onClick={() => decide('approved')}><Check size={14} /> 确认通过</button>
          <button className="outline" onClick={() => decide('review')}>挂起复核</button>
          <button className="primary danger-btn" onClick={() => decide('rejected')}><AlertTriangle size={14} /> 裁决拒绝</button>
        </div>
      </div>
    </div>
  );
}
