import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, Check, ChevronDown, FileCode2, FileText, GitCompare, Layers3,
  Link2, Lock, Paperclip, Plus, RefreshCw, Scale, Search, ShieldCheck, Sparkles, X,
} from 'lucide-react';
import type { BaselineRule, Change, Decision, Doc, Evidence } from './schema';
import { baselineOf, effective, hashOf, short } from './schema';
import type { SaveResult } from './store';
import { store } from './store';
import { LOCKFILE } from './demo';
import { Badge, baselineDecisionLabel, changeText, Chip, Modal, pushToast } from './components';

export interface UI {
  doc: Doc;
  actor: string;
  setActor: (a: string) => void;
  push: (text: string, tone?: 'ok' | 'warn' | 'risk' | 'info') => void;
  go: (v: string) => void;
  selected: string;
  setSelected: (id: string) => void;
  drafts: Change[];
  reloadDrafts: () => void;
  roundId: string;
  renewRound: () => void;
}

const stateText: Record<string, string> = { ok: '安全', warn: '复核', risk: '高风险' };

// ============================ 恢复 / 争议横幅 ============================
export function RecoveryBanner({ ui }: { ui: UI }) {
  const live = store.interruptedBatch();
  const open = ui.doc.disputes.filter((d) => d.status === 'open');
  const resume = () => pushToast(ui.push, store.resumeBatch(), '已从完整批次继续，未完成项全部重试成功');

  return (
    <>
      {live && (live.batch.state === 'interrupted' || live.batch.state === 'running') && (
        <div className="banner risk">
          <AlertTriangle size={16} />
          <div>
            <b>批次中断 · {live.batch.title}</b>
            <span>
              完整批次已保留（材料 {short(live.batch.materialHash)}）：
              已完成 {live.batch.items.filter((i) => i.state === 'done').length}/{live.batch.items.length} 项，
              待重试 {live.batch.items.filter((i) => i.state !== 'done').length} 项
              {live.batch.diskError ? ` · ${live.batch.diskError}` : ''}
            </span>
          </div>
          <button className="primary" onClick={resume}><RefreshCw size={14} />从完整批次继续</button>
          <button className="outline" onClick={() => ui.go('receipts')}>查看回执</button>
        </div>
      )}
      {open.length > 0 && (!live || live.batch.state === 'committed') && (
        <div className="banner warn" onClick={() => ui.go('disputes')} style={{ cursor: 'pointer' }}>
          <GitCompare size={16} />
          <div>
            <b>{open.length} 条待裁决争议</b>
            <span>后到者的材料已完整保留在争议清单中，点击前往合并或驳回</span>
          </div>
          <button className="outline" onClick={(e) => { e.stopPropagation(); ui.go('disputes'); }}>前往争议清单</button>
        </div>
      )}
    </>
  );
}

// ============================ 依赖总览 + 裁决 ============================
export function DepsView({ ui }: { ui: UI }) {
  const { doc } = ui;
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('全部');
  const [showVerdict, setShowVerdict] = useState(false);
  const [showCover, setShowCover] = useState<'grant' | 'exemption' | null>(null);
  const [decision, setDecision] = useState<Decision>('warn');
  const [note, setNote] = useState('');
  const [coverTitle, setCoverTitle] = useState('');
  const [coverRef, setCoverRef] = useState('');

  const c = doc.components.find((x) => x.id === ui.selected) ?? doc.components[0];
  const openDisputes = doc.disputes.filter((d) => d.status === 'open');
  const filtered = useMemo(() => doc.components.filter((d) => {
    const e = effective(doc, d, openDisputes);
    const hit =
      filter === '全部' ? true
      : filter === 'stale' ? e.stale
      : filter === 'covered' ? e.covered !== null
      : e.decision === filter;
    return hit && `${d.name}${d.declaredLicense}`.toLowerCase().includes(query.toLowerCase());
  }), [doc, filter, query, openDisputes.length]);

  if (!c) return <div className="empty">暂无依赖，先导入锁文件</div>;
  const eff = effective(doc, c, openDisputes);
  const grant = doc.grants.filter((g) => g.componentId === c.id).slice(-1)[0];
  const exemption = doc.exemptions.filter((x) => x.componentId === c.id).slice(-1)[0];
  const evidence = store.evidenceFor(c.id);
  const base = baselineOf(doc);
  const rule = base.rules.find((r) => r.license === c.declaredLicense);

  const addDraft = (ch: Change) => {
    store.saveDraft(ui.actor, [...ui.drafts, ch]);
    ui.reloadDrafts();
    ui.push('已加入本标签暂存（不会覆盖另一标签）', 'info');
  };
  const submitVerdict = () => {
    const r = store.saveBatch('review', `裁决 ${c.name} · ${stateText[decision]}`, [
      { t: 'verdict', componentId: c.id, decision, note: note || '审计员裁决' },
    ], ui.actor, { roundId: ui.roundId });
    pushToast(ui.push, r, '裁决已随批次回执落盘');
    setShowVerdict(false); setNote('');
  };
  const reconfirm = () => pushToast(ui.push, store.reconfirm(c.id, ui.actor), '已按当前指纹与基线重新确认');
  const submitCover = () => {
    if (!coverTitle.trim()) return;
    const ch: Change = showCover === 'grant'
      ? {
          t: 'grant',
          grantId: 'g_' + Math.random().toString(36).slice(2, 10),
          grant: {
            title: coverTitle, vendor: coverRef || '供应商',
            componentId: c.id, commercialKey: `COMM-${Math.random().toString(36).slice(2, 9).toUpperCase()}`,
            ref: '合同/授权书', expiresAt: Date.now() + 365 * 86400e3,
          },
        }
      : {
          t: 'exemption',
          exId: 'x_' + Math.random().toString(36).slice(2, 10),
          ex: { componentId: c.id, reason: coverTitle, ticket: coverRef || `EX-${Date.now() % 100000}`, expiresAt: Date.now() + 365 * 86400e3 },
        };
    const r = store.saveBatch(showCover === 'grant' ? 'grant' : 'review', showCover === 'grant' ? `商业授权覆盖 ${c.name}` : `豁免覆盖 ${c.name}`, [ch], ui.actor, { roundId: ui.roundId });
    pushToast(ui.push, r, showCover === 'grant' ? '商业授权已覆盖对应组件' : '豁免已覆盖对应组件');
    setShowCover(null); setCoverTitle(''); setCoverRef('');
  };

  return (
    <section className="workspace">
      <div className="table-pane">
        <div className="pane-head">
          <div><h2>依赖与裁决</h2><p>包指纹或基线更新后，旧裁决进入待确认</p></div>
          <div className="tools">
            <div className="search"><Search size={15} /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索依赖" /></div>
            <select value={filter} onChange={(e) => setFilter(e.target.value)}>
              <option value="全部">全部</option>
              <option value="stale">待重新确认</option>
              <option value="ok">安全</option>
              <option value="warn">复核</option>
              <option value="risk">高风险</option>
              <option value="covered">授权/豁免覆盖</option>
            </select>
          </div>
        </div>
        <div className="table">
          <div className="tr th dep-cols"><span>依赖名称</span><span>版本 / 指纹</span><span>许可证</span><span>有效结论</span></div>
          {filtered.map((d) => {
            const e = effective(doc, d, openDisputes);
            return (
              <button key={d.id} className={`tr dep-cols ${c.id === d.id ? 'selected' : ''}`} onClick={() => ui.setSelected(d.id)}>
                <span className="dep-name"><span className="pkg-dot" />{d.name}{e.stale && <Chip tone="warn" title="包指纹或基线已更新，等待重新确认">待确认</Chip>}</span>
                <span className="muted mono">{d.version} <em>…{short(d.fingerprint)}</em></span>
                <span><i className="license">{d.declaredLicense}</i></span>
                <span><Badge eff={e} /></span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="detail">
        <div className="detail-head">
          <div className="detail-icon"><FileCode2 size={20} /></div>
          <div><span>SELECTED COMPONENT</span><h2>{c.name}</h2></div>
          <button className="close" onClick={() => ui.setSelected('')}><X size={16} /></button>
        </div>
        <div className="detail-grid">
          <div><label>版本</label><b className="mono">{c.version}</b></div>
          <div><label>来源</label><b>{c.source}</b></div>
          <div><label>包指纹</label><b className="mono small">…{short(c.fingerprint)}</b></div>
        </div>

        {eff.stale && (
          <div className="finding warn stale-box">
            <div className="finding-icon"><RefreshCw size={15} /></div>
            <div>
              <b>旧裁决等待重新确认</b>
              <p>
                {c.verdict && c.verdict.basisFp !== c.fingerprint && '包指纹已更新（锁文件中的版本/许可证变化）；'}
                {c.verdict && c.verdict.basisBaseline !== base.version && `策略基线已更新到 ${base.version}；`}
                原裁决：{c.verdict ? stateText[c.verdict.decision] : '无'}（{c.verdict?.by ?? '基线'}，依据 {c.verdict?.basisBaseline ?? '—'}）
              </p>
              <button className="primary sm" onClick={reconfirm}><Check size={13} />按当前指纹与基线重新确认</button>
            </div>
          </div>
        )}

        <div className={`finding ${eff.decision === 'cleared' || eff.decision === 'exempt' ? 'ok' : eff.decision}`}>
          <div className="finding-icon">{eff.decision === 'risk' || eff.decision === 'warn' ? <AlertTriangle size={16} /> : <Check size={16} />}</div>
          <div>
            <b>
              {eff.decision === 'ok' && '可以放心使用'}
              {eff.decision === 'warn' && '需要保留声明'}
              {eff.decision === 'risk' && '存在分发限制'}
              {eff.decision === 'cleared' && `商业授权已覆盖（${grant?.commercialKey}）`}
              {eff.decision === 'exempt' && `豁免已覆盖（${exemption?.ticket}）`}
            </b>
            <p>
              {c.verdict ? c.verdict.note : rule ? `基线 ${base.version}：${rule.rationale}` : '当前基线未收录该许可证，请人工裁决。'}
              {c.verdict && <> · 裁决人 {c.verdict.by}，依据基线 {c.verdict.basisBaseline}{c.verdict.reconfirmedAt ? '，已重新确认' : ''}</>}
            </p>
          </div>
        </div>

        <div className="ev-inline">
          <div><Paperclip size={14} /><span>许可证证据（{evidence.length}）</span></div>
          {evidence.length === 0 && <p className="muted">尚无证据，可从锁文件导入或手动补证</p>}
          {evidence.map((e) => (
            <div key={e.id} className="ev-row" title={`证据指纹 …${short(e.hash)}`}>
              <FileText size={13} />
              <span>{e.title}</span>
              <em className="mono">…{short(e.hash)}</em>
            </div>
          ))}
          <button className="link-btn" onClick={() => addDraft({
            t: 'evidence', componentId: c.id,
            ev: { kind: 'license', title: `${c.name}/LICENSE 原文`, ref: `${c.name} ${c.version}`, hash: hashOf(['lic-manual', c.id, c.fingerprint]) },
          })}><Plus size={13} />补许可证证据（进本标签暂存）</button>
        </div>

        <div className="detail-actions">
          <button className="outline sm" onClick={() => setShowVerdict(true)}><Scale size={14} />记录裁决</button>
          <button className="outline sm" onClick={() => setShowCover('grant')}><ShieldCheck size={14} />商业授权覆盖</button>
          <button className="outline sm" onClick={() => setShowCover('exemption')}><Link2 size={14} />豁免覆盖</button>
        </div>
      </div>

      {showVerdict && (
        <Modal title={`裁决 · ${c.name}`} onClose={() => setShowVerdict(false)}>
          <label>结论
            <select value={decision} onChange={(e) => setDecision(e.target.value as Decision)}>
              <option value="ok">安全 · 可商用</option>
              <option value="warn">需复核 · 保留声明</option>
              <option value="risk">高风险 · 分发限制</option>
            </select>
          </label>
          <label>意见<textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="依据的证据与条款…" rows={3} /></label>
          <button className="primary full" onClick={submitVerdict}>保存裁决（同一审查轮次 {short(ui.roundId)}）</button>
        </Modal>
      )}
      {showCover && (
        <Modal title={showCover === 'grant' ? `商业授权覆盖 · ${c.name}` : `豁免覆盖 · ${c.name}`} onClose={() => setShowCover(null)}>
          <label>{showCover === 'grant' ? '授权/合同名称' : '豁免理由'}
            <input value={coverTitle} onChange={(e) => setCoverTitle(e.target.value)} placeholder={showCover === 'grant' ? '如 Acme 企业商业授权' : '如 仅内部工具不分发'} />
          </label>
          <label>{showCover === 'grant' ? '供应商/授权方' : '工单号'}
            <input value={coverRef} onChange={(e) => setCoverRef(e.target.value)} placeholder={showCover === 'grant' ? 'Acme Corp.' : 'LEGAL-123'} />
          </label>
          <button className="primary full" onClick={submitCover}>{showCover === 'grant' ? '登记授权并覆盖该组件' : '登记豁免并覆盖该组件'}</button>
        </Modal>
      )}
    </section>
  );
}

// ============================ 许可证证据 ============================
export function EvidenceView({ ui }: { ui: UI }) {
  const evs = store.evidenceList();
  const links = useMemo(() => {
    const out: Record<string, string> = {};
    evs.forEach((e) => { out[e.id] = store.evidenceComponent(e.id) ?? ''; });
    return out;
  }, [evs.length, ui.doc.rev]);

  return (
    <section className="card-list">
      <div className="pane-head static">
        <div><h2>许可证证据</h2><p>证据带内容指纹，随批次材料落盘；锁文件证据在导入时自动建立关联</p></div>
      </div>
      <div className="ev-table">
        {evs.map((e: Evidence) => {
          const comp = ui.doc.components.find((c) => c.id === links[e.id]);
          return (
            <div key={e.id} className="ev-card" onClick={() => comp && (ui.setSelected(comp.id), ui.go('deps'))}>
              <div className={`ev-kind ${e.kind}`}>{e.kind === 'lockfile' ? <Lock size={15} /> : <FileText size={15} />}</div>
              <div className="ev-body">
                <b>{e.title}</b>
                <span>{e.ref} · {e.by}</span>
                <div className="ev-meta">
                  <Chip tone={comp ? 'ok' : 'warn'}>{comp ? `关联组件 ${comp.name}` : '未关联'}</Chip>
                  <Chip title="证据内容指纹"><span className="mono">sha …{short(e.hash)}</span></Chip>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ============================ 策略基线 ============================
export function BaselineView({ ui }: { ui: UI }) {
  const { doc } = ui;
  const base = baselineOf(doc);
  const [rules, setRules] = useState<BaselineRule[]>(base.rules.map((r) => ({ ...r })));
  const [version, setVersion] = useState(`BL-2025.${Number(base.version.split('.')[1] || 0) + 1}`);
  const [name, setName] = useState('收购尽调基线（更新）');

  useEffect(() => {
    setRules(baselineOf(ui.doc).rules.map((r) => ({ ...r })));
  }, [ui.doc.baselineId]);

  const update = (license: string, patch: Partial<BaselineRule>) =>
    setRules((rs) => rs.map((r) => (r.license === license ? { ...r, ...patch } : r)));
  const publish = () => {
    const r = store.saveBatch('baseline', `发布策略基线 ${version}`, [{
      t: 'baseline',
      baselineId: 'bl_' + version.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      baseline: { version, name, rules },
    }], ui.actor);
    pushToast(ui.push, r, `基线 ${version} 已发布，旧裁决等待重新确认`);
  };

  return (
    <section className="baseline-wrap">
      <div className="table-pane">
        <div className="pane-head">
          <div><h2>策略基线</h2><p>当前生效 <b className="mono">{base.version}</b> · {base.name}（{base.by}）</p></div>
        </div>
        <div className="baseline-rules">
          {rules.map((r) => (
            <div key={r.license} className="rule-row">
              <i className="license">{r.license}</i>
              <select value={r.decision} onChange={(e) => update(r.license, { decision: e.target.value as Decision })}>
                <option value="ok">安全</option>
                <option value="warn">需复核</option>
                <option value="risk">高风险</option>
              </select>
              <input value={r.rationale} onChange={(e) => update(r.license, { rationale: e.target.value })} />
              <Chip tone={r.decision}>{baselineDecisionLabel(r.decision)}</Chip>
            </div>
          ))}
        </div>
      </div>
      <div className="table-pane publish-pane">
        <div className="pane-head static"><div><h2>发布新版本</h2><p>基线更新后，basis 失配的旧裁决会在依赖页标记“待确认”</p></div></div>
        <div className="publish-form">
          <label>版本号<input value={version} onChange={(e) => setVersion(e.target.value)} /></label>
          <label>名称<input value={name} onChange={(e) => setName(e.target.value)} /></label>
          <button className="primary" onClick={publish}><Sparkles size={15} />发布基线（批次回执落盘）</button>
        </div>
        <div className="baseline-history">
          <div className="nav-title">历史版本</div>
          {doc.baselines.map((b) => (
            <div key={b.id} className={`history-row ${b.id === doc.baselineId ? 'active' : ''}`}>
              <Layers3 size={14} />
              <span className="mono">{b.version}</span>
              <em>{b.by} · {new Date(b.at).toLocaleDateString()}</em>
              {b.id === doc.baselineId && <Chip tone="ok">生效中</Chip>}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ============================ 批次回执 ============================
export function ReceiptsView({ ui }: { ui: UI }) {
  const { doc } = ui;
  const batches = [...doc.batches].reverse();
  const [openId, setOpenId] = useState('');

  return (
    <section className="card-list">
      <div className="pane-head static">
        <div><h2>批次回执（哈希链）</h2>
          <p>每批材料指纹与上一批回执串联：…{short(doc.headHash)} 为链头 · 当前修订 r{doc.rev}</p>
        </div>
      </div>
      <div className="receipts">
        {batches.map((b) => (
          <div key={b.id} className={`receipt ${b.state}`}>
            <button className="receipt-head" onClick={() => setOpenId(openId === b.id ? '' : b.id)}>
              <span className={`rc-state ${b.state}`}>
                {b.state === 'committed' ? <Check size={13} /> : b.state === 'disputed' ? <GitCompare size={13} /> : <AlertTriangle size={13} />}
                {b.state === 'committed' ? '已提交' : b.state === 'disputed' ? '争议' : b.state === 'interrupted' ? '已中断' : '进行中'}
              </span>
              <span className="rc-title">{b.title}</span>
              <span className="rc-meta">
                <em>{b.by}</em>
                <Chip>r{b.baseRev}{b.commitRev ? ` → r${b.commitRev}` : ''}</Chip>
                <Chip>{b.items.length} 项</Chip>
                <Chip tone="purple" title="审查轮次">轮 …{short(b.roundId)}</Chip>
              </span>
              <ChevronDown size={15} className={openId === b.id ? 'up' : ''} />
            </button>
            {openId === b.id && (
              <div className="receipt-body">
                <div className="hashline">
                  <div><label>材料指纹</label><b className="mono">…{short(b.materialHash)}</b></div>
                  <div><label>上一批回执</label><b className="mono">…{short(b.parentHash)}</b></div>
                  <div><label>本批回执</label><b className="mono">…{short(b.hash)}</b></div>
                </div>
                {b.items.length > 0 && (
                  <div className="item-list">
                    {b.items.map((it) => (
                      <div key={it.key} className={`item ${it.state}`}>
                        {it.state === 'done' ? <Check size={12} /> : it.state === 'failed' ? <AlertTriangle size={12} /> : <RefreshCw size={12} />}
                        <span>{it.label}</span>
                        <em>{it.state === 'done' ? '已确认' : it.state === 'failed' ? it.error : '待重试'}</em>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

// ============================ 争议清单 ============================
export function DisputesView({ ui }: { ui: UI }) {
  const disputes = [...ui.doc.disputes].reverse();
  const [resolving, setResolving] = useState<string | null>(null);
  const [text, setText] = useState('');

  const resolve = (reapply: boolean) => {
    if (!resolving) return;
    store.resolveDispute(resolving, text || (reapply ? '采纳后到者材料，作为新一轮提交' : '驳回后到者材料，维持先到版本'), reapply, ui.actor);
    ui.push(reapply ? '后到者材料已作为新一轮批次重新落盘' : '争议已驳回，维持先到版本', reapply ? 'ok' : 'info');
    setResolving(null); setText('');
  };

  return (
    <section className="card-list">
      <div className="pane-head static">
        <div><h2>争议清单</h2><p>两标签同时保存同一审查轮次时，后到者材料完整保留于此，不覆盖先到落盘</p></div>
      </div>
      {disputes.length === 0 && <div className="empty">暂无争议。可用顶部“模拟同轮并发保存”制造一例。</div>}
      <div className="disputes">
        {disputes.map((d) => {
          const batch = ui.doc.batches.find((b) => b.id === d.batchId);
          return (
            <div key={d.id} className={`dispute ${d.status}`}>
              <div className="dispute-head">
                <GitCompare size={16} />
                <b>{batch?.title ?? '后到批次'}</b>
                <Chip tone={d.status === 'open' ? 'warn' : 'ok'}>{d.status === 'open' ? '待裁决' : '已处理'}</Chip>
                <span className="muted">后到者：{d.by} · 轮 …{short(d.roundId)} · r{d.baseRev} → r{d.winnerRev}</span>
              </div>
              <p>{d.reason}</p>
              <div className="item-list">
                {d.changes.map((c, i) => (
                  <div key={i} className="item pending"><FileCode2 size={12} /><span>{changeText(c)}</span><em>后到材料</em></div>
                ))}
              </div>
              {d.status === 'open' ? (
                <div className="dispute-actions">
                  <button className="primary sm" onClick={() => setResolving(d.id)}><Check size={13} />采纳：材料作为新一轮提交</button>
                  <button className="outline sm" onClick={() => setResolving(d.id)}><X size={13} />驳回：维持先到版本</button>
                </div>
              ) : (
                <p className="muted resolution">处理结果：{d.resolution} · {new Date(d.resolvedAt ?? 0).toLocaleString()}</p>
              )}
              {resolving === d.id && (
                <div className="resolve-box">
                  <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="裁决意见（可留空使用默认）" rows={2} />
                  <div>
                    <button className="primary sm" onClick={() => resolve(true)}>确认采纳并重新落盘</button>
                    <button className="outline sm" onClick={() => resolve(false)}>确认驳回</button>
                    <button className="link-btn" onClick={() => setResolving(null)}>取消</button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

// 供锁文件场景展示使用
export { LOCKFILE };
export type { SaveResult };
