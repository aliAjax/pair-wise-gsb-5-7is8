import { useMemo, useState } from 'react';
import {
  AlertTriangle, ChevronDown, DatabaseBackup, Download, FileCode2, FolderInput,
  GitCompare, Layers3, Power, RefreshCw, Scale, Send, ShieldCheck, Sparkles, Upload, X,
} from 'lucide-react';
import type { Change, Toast } from './review/schema';
import { effective, short } from './review/schema';
import { AUDITORS, store, useStore } from './review/store';
import { grantChange, lockfileChanges, LOCKFILE, LOCK_REF } from './review/demo';
import { changeText, pushToast, ToastStack } from './review/components';
import { BaselineView, DepsView, DisputesView, EvidenceView, ReceiptsView, RecoveryBanner, type UI } from './review/views';

const NAV = [
  { id: 'deps', label: '依赖与裁决', icon: Layers3 },
  { id: 'evidence', label: '许可证证据', icon: FileCode2 },
  { id: 'baseline', label: '策略基线', icon: Scale },
  { id: 'receipts', label: '批次回执', icon: DatabaseBackup },
  { id: 'disputes', label: '争议清单', icon: GitCompare },
];

export default function App() {
  const doc = useStore();
  const [view, setView] = useState('deps');
  const [actor, setActor] = useState(AUDITORS[0]);
  const [selected, setSelected] = useState(doc.components[0]?.id ?? '');
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [roundId, setRoundId] = useState(() => `round_${Date.now().toString(36)}`);
  const [drafts, setDrafts] = useState<Change[]>(() => store.loadDraft(AUDITORS[0]));
  const [faultOn, setFaultOn] = useState(store.faultEnabled);

  const push = (text: string, tone: Toast['tone'] = 'info') => {
    const id = Math.random().toString(36).slice(2);
    setToasts((ts) => [...ts, { id, text, tone }]);
    setTimeout(() => setToasts((ts) => ts.filter((t) => t.id !== id)), 5200);
  };
  const dismissToast = (id: string) => setToasts((ts) => ts.filter((t) => t.id !== id));
  const reloadDrafts = () => setDrafts(store.loadDraft(actor));

  const switchActor = (a: string) => { setActor(a); setDrafts(store.loadDraft(a)); };
  const renewRound = () => { setRoundId(`round_${Date.now().toString(36)}`); push('已开启新的审查轮次', 'info'); };

  const openDisputes = doc.disputes.filter((d) => d.status === 'open').length;
  const staleCount = doc.components.filter((c) => effective(doc, c, doc.disputes.filter((d) => d.status === 'open')).stale).length;
  const riskCount = doc.components.filter((c) => {
    const e = effective(doc, c, doc.disputes.filter((d) => d.status === 'open'));
    return e.decision === 'risk';
  }).length;
  const live = store.interruptedBatch();

  const ui: UI = { doc, actor, setActor: switchActor, push, go: setView, selected, setSelected, drafts, reloadDrafts, roundId, renewRound };

  // ---- 场景 1：甲导入锁文件（故障开关开启时演示扫描中断 + 半截依赖）----
  const importLock = () => {
    const r = store.saveBatch('import', `锁文件导入 · ${LOCKFILE.length} 个依赖（${LOCK_REF}）`, lockfileChanges(), actor, {
      roundId,
      // 故障开关打开时：前 5 次写入成功、第 6 次失败 → 半截依赖；之后持续失败直到排除故障
      faultAfter: faultOn ? 5 : -1,
    });
    pushToast(push, r, '锁文件导入完成：指纹变化的组件，其旧裁决已等待重新确认');
  };

  // ---- 场景 2：乙在另一个标签补商业授权（独立批次落盘，不碰甲的暂存）----
  const yiAddsGrant = () => {
    const pdf = doc.components.find((c) => c.name === 'pdf-kit-pro');
    if (!pdf) { push('请先导入锁文件，再让乙补商业授权', 'warn'); return; }
    const r = store.saveBatch('grant', '乙：PDFKit Pro 企业授权（另一标签）', [grantChange({
      componentId: pdf.id, title: 'PDFKit Pro 企业授权', vendor: 'Acme PDF Inc.',
      key: 'COMM-7F3A92C1', ref: 'MSA-2026-114', days: 365,
    })], AUDITORS[1]);
    pushToast(push, r, '乙的商业授权已在另一标签落盘，覆盖对应组件（不影响甲的暂存）');
  };

  // ---- 场景 3：两标签同时保存同一批次 ----
  const concurrentSave = () => {
    const pdf = doc.components.find((c) => c.name === 'pdf-kit-pro');
    if (!pdf) { push('请先导入锁文件', 'warn'); return; }
    const grant = grantChange({
      componentId: pdf.id, title: 'PDFKit Pro 企业授权', vendor: 'Acme PDF Inc.',
      key: 'COMM-7F3A92C1', ref: 'MSA-2026-114', days: 365,
    });
    // 对端标签（乙）先落盘同一审查轮次
    store.foreignCommit('grant', '乙：商业授权批次（标签B 先到）', [grant], AUDITORS[1], roundId);
    // 本标签（甲）随后保存同一轮次：后到者保留材料并进入争议清单
    const r = store.saveBatch('grant', '甲：商业授权批次（标签A 后到）', [grant], AUDITORS[0], { roundId });
    pushToast(push, r, '保存成功');
    setView('disputes');
  };

  // ---- 本标签暂存：提交 / 清空 ----
  const submitDrafts = () => {
    const changes = store.loadDraft(actor);
    if (!changes.length) { push('暂存为空：乙补授权、手动补证等会先进入这里', 'warn'); return; }
    const r = store.saveBatch('review', `${actor} 的审查批次（${changes.length} 项材料）`, changes, actor, { roundId });
    pushToast(push, r, '批次已提交，回执已与上一批串联');
    if (r.ok) store.clearDraft(actor);
    reloadDrafts();
  };

  const exportReport = () => {
    const openD = doc.disputes.filter((d) => d.status === 'open');
    const lines = [
      '# License Lens 审查报告',
      `基线：${doc.baselines.find((b) => b.id === doc.baselineId)?.version} · 修订 r${doc.rev} · 链头 …${short(doc.headHash)}`,
      '',
      '| 依赖 | 版本 | 声明许可 | 指纹 | 有效结论 | 待确认 | 覆盖 |',
      '|---|---|---|---|---|---|---|',
      ...doc.components.map((c) => {
        const e = effective(doc, c, openD);
        const g = doc.grants.find((x) => x.componentId === c.id);
        const x = doc.exemptions.find((z) => z.componentId === c.id);
        return `| ${c.name} | ${c.version} | ${c.declaredLicense} | …${short(c.fingerprint)} | ${e.decision} | ${e.stale ? '是' : ''} | ${g ? '授权' : x ? '豁免' : ''} |`;
      }),
    ];
    const blob = new Blob([lines.join('\n')], { type: 'text/markdown' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `license-review-r${doc.rev}.md`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const counts = {
    total: doc.components.length,
    ok: doc.components.filter((c) => ['ok', 'cleared', 'exempt'].includes(effective(doc, c, doc.disputes.filter((d) => d.status === 'open')).decision)).length,
    warn: doc.components.filter((c) => effective(doc, c, doc.disputes.filter((d) => d.status === 'open')).decision === 'warn').length,
    risk: riskCount,
  };

  return (
    <div className="shell">
      <aside>
        <div className="brand">
          <div className="brand-icon"><ShieldCheck size={18} /></div>
          <div><b>License Lens</b><small>recoverable review chain</small></div>
        </div>
        <div className="nav-title">REVIEW CHAIN</div>
        {NAV.map((n) => (
          <button key={n.id} className={`nav ${view === n.id ? 'active' : ''}`} onClick={() => setView(n.id)}>
            <n.icon size={16} />{n.label}
            {n.id === 'disputes' && openDisputes > 0 && <span className="red">{openDisputes}</span>}
            {n.id === 'deps' && staleCount > 0 && <span className="amber">{staleCount}</span>}
          </button>
        ))}
        <div className="aside-bottom">
          <div className="mini-card">
            <GitCompare size={16} />
            <div>
              <b>双标签协作</b>
              <small>同轮次并发保存 → 后到者进争议清单，材料不丢</small>
            </div>
          </div>
          <div className="user">
            <div className={`avatar ${actor === AUDITORS[0] ? 'a' : 'b'}`}>{actor === AUDITORS[0] ? '甲' : '乙'}</div>
            <select value={actor} onChange={(e) => switchActor(e.target.value)} className="actor-select">
              {AUDITORS.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          </div>
        </div>
      </aside>

      <main>
        <header>
          <div>
            <div className="crumb">WORKSPACE / <b>AURORA-WEB · M&amp;A DUE DILIGENCE</b></div>
            <h1>可恢复许可证审查链</h1>
            <p>依赖指纹 · 许可证证据 · 策略基线 · 批次回执，逐项落盘、可恢复、可仲裁。</p>
          </div>
          <div className="head-actions">
            <button className="outline" onClick={exportReport}><Download size={15} />导出报告</button>
            <button className="outline" onClick={() => { store.resetAll(); setDrafts([]); setView('deps'); push('已重置为初始快照', 'info'); }}>
              <RefreshCw size={14} />重置
            </button>
          </div>
        </header>

        <RecoveryBanner ui={ui} />

        {/* 场景工具条 */}
        <div className="scenario-bar">
          <span className="sc-label"><Sparkles size={13} />演练</span>
          <button className="chip-btn" onClick={importLock}><FolderInput size={14} />甲：导入锁文件{faultOn ? '（故障中→中断）' : ''}</button>
          <button className="chip-btn" onClick={yiAddsGrant}><Upload size={14} />乙：另一标签补商业授权</button>
          <button className="chip-btn" onClick={concurrentSave}><GitCompare size={14} />两标签同时保存同一批次</button>
          <button className={`chip-btn toggle ${faultOn ? 'on' : ''}`} onClick={() => { const v = !faultOn; store.setFault(v); setFaultOn(v); push(v ? '落盘故障已注入：下次导入将在半截中断' : '落盘故障已解除，可从完整批次继续', v ? 'warn' : 'ok'); }}>
            <Power size={13} />{faultOn ? '磁盘故障中（点击恢复）' : '模拟落盘失败'}
          </button>
          <button className="chip-btn" onClick={renewRound}><RefreshCw size={13} />新审查轮次</button>
          <button className="chip-btn" onClick={() => store.installLegacy()}><DatabaseBackup size={13} />模拟旧版数据（刷新即升级）</button>
          <span className="round-tag mono" title="当前标签的审查轮次（并发冲突以它为准）">轮 …{short(roundId)}</span>
        </div>

        {view === 'deps' && (
          <>
            <section className="hero">
              <div>
                <span className="tag">PROJECT · AURORA-WEB · r{doc.rev}</span>
                <h2>{staleCount > 0 ? `${staleCount} 项旧裁决等待重新确认` : '审查链状态一致'}</h2>
                <p>
                  共 <b>{counts.total} 个依赖</b>；
                  链头回执 <b>…{short(doc.headHash)}</b>；
                  {live && <b className="warning"> 存在中断批次</b>}
                  {!live && riskCount > 0 && <b className="warning"> {riskCount} 个高风险组件</b>}
                </p>
              </div>
              <div className="scan-score">
                <div className="score-ring"><strong>{counts.total ? Math.round(counts.ok / counts.total * 100) : 0}<small>%</small></strong></div>
                <div><span>已放行占比</span><b>{counts.ok}/{counts.total}</b><small>含商业授权与豁免覆盖</small></div>
              </div>
            </section>
            <section className="summary">
              <div><span>全部依赖</span><b>{counts.total}</b><small>按包指纹去重</small></div>
              <div><span className="teal-label">放行</span><b className="teal">{counts.ok}</b><small>裁决 / 授权 / 豁免</small></div>
              <div><span>需复核</span><b className="orange">{counts.warn}</b><small>{staleCount} 项待重新确认</small></div>
              <div><span>高风险</span><b className="red">{counts.risk}</b><small>未获覆盖</small></div>
            </section>
          </>
        )}

        {view === 'deps' && <DepsView ui={ui} />}
        {view === 'evidence' && <EvidenceView ui={ui} />}
        {view === 'baseline' && <BaselineView ui={ui} />}
        {view === 'receipts' && <ReceiptsView ui={ui} />}
        {view === 'disputes' && <DisputesView ui={ui} />}

        {/* 本标签 / 本审计员的暂存批次条 */}
        {drafts.length > 0 && (
          <div className="draft-bar">
            <div className="draft-info">
              <b>{actor} 的暂存批次 · {drafts.length} 项材料</b>
              <span>仅保存在本标签，提交后才生成回执；另一标签看不到也覆盖不了</span>
            </div>
            <div className="draft-items">
              {drafts.slice(0, 4).map((c, i) => <i key={i} className="chip neutral">{changeText(c)}</i>)}
              {drafts.length > 4 && <i className="chip neutral">+{drafts.length - 4}</i>}
            </div>
            <button className="primary sm" onClick={submitDrafts}><Send size={13} />保存批次（轮 …{short(roundId)}）</button>
            <button className="link-btn" onClick={() => { store.clearDraft(actor); reloadDrafts(); }}><X size={13} />清空</button>
          </div>
        )}
      </main>

      <ToastStack toasts={toasts} dismiss={dismissToast} />
    </div>
  );
}
