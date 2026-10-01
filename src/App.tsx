import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ChevronDown,
  Download,
  FileCode2,
  Layers3,
  RefreshCw,
  Scale,
  ScrollText,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import { getEngine, useEngineState, AUDITORS } from './state/store';
import { buildViews, openDisputes, pendingItems } from './core/selectors';
import { ComponentList } from './ui/ComponentList';
import { ComponentDetail } from './ui/ComponentDetail';
import { ImportPanel } from './ui/ImportPanel';
import { DisputesPanel } from './ui/DisputesPanel';
import { BaselinePanel } from './ui/BaselinePanel';
import { RecoveryCenter } from './ui/RecoveryCenter';
import { exportReport } from './ui/report';
import { Toast } from './ui/Badge';

type Tab = 'review' | 'baseline' | 'recovery';

export default function App() {
  const engine = useMemo(getEngine, []);
  const state = useEngineState(engine);
  const [auditorId, setAuditorId] = useState(AUDITORS[0].id);
  const [tab, setTab] = useState<Tab>('review');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ msg: string; tone: 'ok' | 'error' | 'info' } | null>(null);
  const [bootInfo, setBootInfo] = useState<{ migrated: number; resumed: number }>({ migrated: 0, resumed: 0 });

  useEffect(() => {
    const info = engine.bootstrap();
    setBootInfo(info);
    const messages: string[] = [];
    if (info.migrated > 0) messages.push(`已从旧版升级 ${info.migrated} 个组件：指纹与策略基线已回填，旧裁决等待重新确认`);
    if (info.resumed > 0) messages.push(`检测到 ${info.resumed} 个未完成批次，可在恢复中心继续`);
    if (messages.length > 0) setToast({ msg: messages.join('；'), tone: 'info' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const auditor = AUDITORS.find((a) => a.id === auditorId) ?? AUDITORS[0];
  const notify = (msg: string, tone: 'ok' | 'error' | 'info' = 'info') => {
    setToast({ msg, tone });
  };
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4200);
    return () => clearTimeout(t);
  }, [toast]);

  const views = buildViews(state);
  const pending = pendingItems(state);
  const pendingIds = useMemo(() => new Set(pending.map((p) => p.item.componentId).filter(Boolean) as string[]), [state]);
  const disputes = openDisputes(state);
  const attention = views.filter((v) => v.validity !== 'fresh').length;

  const headerStats = {
    total: views.length,
    fresh: views.filter((v) => v.validity === 'fresh').length,
    attention,
    rejected: views.filter((v) => v.suggestion.decision === 'rejected' && v.covers.length === 0).length,
    covered: views.filter((v) => v.covers.length > 0).length,
  };

  return (
    <div className="shell">
      <aside>
        <div className="brand">
          <div className="brand-icon"><ShieldCheck size={18} /></div>
          <div><b>License Lens</b><small>recoverable review chain</small></div>
        </div>
        <div className="nav-title">尽调工作台</div>
        <button className={`nav ${tab === 'review' ? 'active' : ''}`} onClick={() => setTab('review')}>
          <Layers3 size={16} />审查链总览
        </button>
        <button className={`nav ${tab === 'baseline' ? 'active' : ''}`} onClick={() => setTab('baseline')}>
          <Scale size={16} />策略基线 <span className="nav-spacer" /> <em className="nav-meta">v{state.baseline.version}</em>
        </button>
        <button className={`nav ${tab === 'recovery' ? 'active' : ''}`} onClick={() => setTab('recovery')}>
          <ScrollText size={16} />批次与恢复
          {pending.length > 0 && <span className="red">{pending.length}</span>}
        </button>
        <button className="nav" onClick={() => document.getElementById('disputes-anchor')?.scrollIntoView({ behavior: 'smooth' })}>
          <AlertTriangle size={16} />争议清单
          {disputes.length > 0 && <span className="red">{disputes.length}</span>}
        </button>

        <div className="aside-bottom">
          <div className="mini-card">
            <RefreshCw size={15} className="spin-slow" />
            <div>
              <b>可恢复审查链</b>
              <small>指纹·证据·基线·回执串联</small>
            </div>
          </div>
          <div className="auditor-switch">
            <label className="switch-label">当前审计身份</label>
            <div className="switcher">
              {AUDITORS.map((a) => (
                <button
                  key={a.id}
                  className={a.id === auditorId ? 'active' : ''}
                  onClick={() => setAuditorId(a.id)}
                  title="模拟在另一个标签中切换审计员；真实协作时请用两个浏览器标签同时打开本页"
                >
                  <span className="avatar sm">{a.initials}</span>{a.name.replace(/（.*?）/, '')}
                </button>
              ))}
            </div>
            <small className="muted">提示：两个浏览器标签打开本页即模拟甲乙同时操作</small>
          </div>
          <div className="user">
            <div className="avatar">{auditor.initials}</div>
            <span>{auditor.name}</span>
            <ChevronDown size={14} />
          </div>
        </div>
      </aside>

      <main>
        <header>
          <div>
            <div className="crumb">AURORA ACQUISITION / <b>DEPENDENCY DUE DILIGENCE</b></div>
            <h1>许可证可恢复审查链</h1>
            <p>依赖指纹、许可证据、策略基线、批次回执串联落盘 —— 中断可续，并发可裁。</p>
          </div>
          <div className="head-actions">
            <button className="outline" onClick={() => exportReport(state)}><Download size={15} />导出审查报告</button>
          </div>
        </header>

        <section className="hero">
          <div>
            <span className="tag">PROJECT · AURORA-WEB · BASELINE v{state.baseline.version}</span>
            <h2>后保存不再抹掉证据，半截扫描不再丢失。</h2>
            <p>
              链上 <b>{headerStats.total} 个组件</b>，<b className="teal">{headerStats.fresh} 条裁决有效</b>，
              <b className="warning"> {headerStats.attention} 项待重新确认</b>，
              <b className="purple-text"> {headerStats.covered} 个有授权/豁免覆盖</b>
              {pending.length > 0 && <>，<b className="red">{pending.length} 个批次项未完成</b></>}
            </p>
          </div>
          <div className="hero-chain">
            <div className="chain-node"><Layers3 size={15} /><b>指纹</b><small>name@version+license</small></div>
            <span className="chain-link" />
            <div className="chain-node"><FileCode2 size={15} /><b>证据</b><small>授权/豁免按组件覆盖</small></div>
            <span className="chain-link" />
            <div className="chain-node"><Scale size={15} /><b>基线 v{state.baseline.version}</b><small>版本化裁决口径</small></div>
            <span className="chain-link" />
            <div className="chain-node"><ScrollText size={15} /><b>回执</b><small>完整批次可恢复</small></div>
          </div>
        </section>

        {bootInfo.migrated > 0 && (
          <div className="banner info">
            <Sparkles size={15} />
            旧版数据已升级：组件指纹与当前基线版本已回填，全部历史裁决标记为「待重新确认」。
          </div>
        )}
        {pending.length > 0 && (
          <div className="banner warn">
            <AlertTriangle size={15} />
            有 {pending.length} 个批次项未完成（中断或落盘失败）。
            <button className="link-btn" onClick={() => setTab('recovery')}>前往恢复中心 →</button>
          </div>
        )}
        {disputes.length > 0 && (
          <div className="banner danger">
            <AlertTriangle size={15} />
            {disputes.length} 条并发保存争议待处理：先到者材料保留，后到者材料在争议清单中。
            <button className="link-btn" onClick={() => document.getElementById('disputes-anchor')?.scrollIntoView({ behavior: 'smooth' })}>查看 →</button>
          </div>
        )}

        {tab === 'review' && (
          <>
            <ImportPanel engine={engine} auditor={auditor} notify={notify} />
            <section className="summary">
              <div><span>组件总数</span><b>{headerStats.total}</b><small>锁文件逐项入链</small></div>
              <div><span>裁决有效</span><b className="teal">{headerStats.fresh}</b><small>指纹+基线均匹配</small></div>
              <div><span>待重新确认</span><b className="orange">{headerStats.attention}</b><small>指纹/基线/迁移失效</small></div>
              <div><span>授权覆盖</span><b className="purple">{headerStats.covered}</b><small>商业授权或豁免</small></div>
              <div><span>仍被基线拒绝</span><b className="red">{headerStats.rejected}</b><small>且无覆盖材料</small></div>
            </section>
            <section className="workspace">
              <ComponentList
                state={state}
                engine={engine}
                auditor={auditor}
                selectedId={selectedId}
                onSelect={setSelectedId}
                pendingIds={pendingIds}
              />
              {selectedId && (
                <ComponentDetail
                  state={state}
                  engine={engine}
                  auditor={auditor}
                  componentId={selectedId}
                  onClose={() => setSelectedId(null)}
                  notify={notify}
                />
              )}
            </section>
            <div id="disputes-anchor" className="anchor-offset" />
            <DisputesPanel state={state} engine={engine} auditor={auditor} notify={notify} />
          </>
        )}

        {tab === 'baseline' && (
          <BaselinePanel state={state} engine={engine} auditor={auditor} notify={notify} />
        )}
        {tab === 'recovery' && <RecoveryCenter state={state} engine={engine} auditor={auditor} notify={notify} />}
      </main>
      <Toast message={toast?.msg ?? null} tone={toast?.tone ?? 'info'} onClose={() => setToast(null)} />
    </div>
  );
}
