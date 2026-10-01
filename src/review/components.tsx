import type { ReactNode } from 'react';
import { AlertTriangle, Check, Info, ShieldOff, X } from 'lucide-react';
import type { Decision, Doc, Effective } from './schema';
import { effective } from './schema';
import { store } from './store';

export function ToastStack({ toasts, dismiss }: { toasts: { id: string; text: string; tone: 'ok' | 'warn' | 'risk' | 'info' }[]; dismiss: (id: string) => void }) {
  return (
    <div className="toast-stack">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.tone}`} onClick={() => dismiss(t.id)}>
          {t.tone === 'ok' ? <Check size={14} /> : t.tone === 'info' ? <Info size={14} /> : <AlertTriangle size={14} />}
          <span>{t.text}</span>
        </div>
      ))}
    </div>
  );
}

export function Badge({ eff }: { eff: Effective }) {
  const map: Record<string, { cls: string; text: string; icon?: ReactNode }> = {
    ok: { cls: 'ok', text: '安全', icon: <Check size={12} /> },
    warn: { cls: 'warn', text: '复核', icon: <AlertTriangle size={12} /> },
    risk: { cls: 'risk', text: '高风险', icon: <AlertTriangle size={12} /> },
    cleared: { cls: 'ok', text: '商业授权已覆盖', icon: <ShieldOff size={12} /> },
    exempt: { cls: 'ok', text: '豁免已覆盖', icon: <Check size={12} /> },
  };
  const m = map[eff.decision];
  return (
    <span className={`eff-badge ${m.cls}`}>
      {m.icon}{m.text}
      {eff.stale && <em className="stale-dot" title="包指纹或基线已更新，等待重新确认" />}
      {eff.disputed && <em className="dispute-dot" title="该组件存在待裁决争议" />}
    </span>
  );
}

export function EffFor({ doc, componentId }: { doc: Doc; componentId: string }) {
  const c = doc.components.find((x) => x.id === componentId);
  if (!c) return null;
  return <Badge eff={effective(doc, c, doc.disputes.filter((d) => d.status === 'open'))} />;
}

export function Chip({ children, tone = 'neutral', title }: { children: ReactNode; tone?: 'neutral' | 'ok' | 'warn' | 'risk' | 'purple'; title?: string }) {
  return <i className={`chip ${tone}`} title={title}>{children}</i>;
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  return (
    <div className="backdrop" onClick={onClose}>
      <div className={`modal ${wide ? 'wide' : ''}`} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button onClick={onClose}><X size={18} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function changeText(c: import('./schema').Change): string {
  switch (c.t) {
    case 'component': return `导入 ${c.component.name}@${c.component.version}（${c.component.declaredLicense}）`;
    case 'verdict': return `裁决 ${c.componentId} → ${c.decision}`;
    case 'reconfirm': return `重新确认 ${c.componentId}`;
    case 'evidence': return `证据 ${c.ev.title}`;
    case 'grant': return `商业授权 ${c.grant.title} → ${c.grant.componentId}`;
    case 'exemption': return `豁免 ${c.ex.componentId}（${c.ex.ticket}）`;
    case 'baseline': return `发布基线 ${c.baseline.version}`;
  }
}

export function pushToast(push: (text: string, tone?: 'ok' | 'warn' | 'risk' | 'info') => void, r: import('./store').SaveResult, okText: string) {
  if (r.ok) { push(okText, 'ok'); return; }
  if (r.disputeId) { push('已进入争议清单：后到者材料完整保留，等待裁决', 'warn'); return; }
  if (r.interrupted) { push(`落盘失败，批次已中断 —— 可从完整批次继续（${r.diskError}）`, 'risk'); return; }
  push('操作未完成', 'warn');
}

export function baselineDecisionLabel(d: Decision): string {
  return d === 'ok' ? '安全' : d === 'warn' ? '需复核' : '高风险';
}

export { store };
