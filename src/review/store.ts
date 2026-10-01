import { useSyncExternalStore } from 'react';
import type {
  Baseline, Batch, BatchItem, Change, Component, Decision, Dispute, Doc, Evidence, Exemption, Grant,
} from './schema';
import { baselineOf, changeComponentId, clone, fpOf, hashOf, slug } from './schema';
import { legacyV1, seedDoc, seedEvidence, seedEvidenceLinks } from './seed';

const DOC_KEY = 'license-lens:doc';
const LIVE_KEY = 'license-lens:live';       // 运行中/中断的批次（完整材料 + 检查点游标）
const FAULT_KEY = 'license-lens:fault';     // 落盘故障模拟：每次写入都失败
const EVIDENCE_KEY = 'license-lens:evidence';
const LINKS_KEY = 'license-lens:evidence-links';
const DRAFT_KEY = (who: string) => `license-lens:draft:${slug(who)}`;
const CH = 'license-lens-channel';

type Listener = () => void;

export interface LiveBatch {
  batch: Batch;
}

export interface SaveResult {
  ok: boolean;
  batchId?: string;
  interrupted?: boolean;
  diskError?: string;
  conflictBaseRev?: number;
  winnerBatchId?: string;
  disputeId?: string;
}

export const AUDITORS = ['甲（审计员）', '乙（审计员）'];

function readLinks(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(LINKS_KEY) || '{}'); } catch { return {}; }
}
function writeLinks(v: Record<string, string>) {
  localStorage.setItem(LINKS_KEY, JSON.stringify(v));
}

const idOf = (prefix: string) =>
  `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const shortId = (id?: string) => (id ? id.slice(-6) : '');

// ---------------------------------------------------------------------------
// 旧数据升级：v1 依赖数组 → v2 审查文档，回填包指纹、许可证证据与策略基线
// ---------------------------------------------------------------------------
function migrateV1(raw: string): Doc {
  const doc = seedDoc();
  const rows = JSON.parse(raw) as Array<{
    id: number; name: string; version: string; license: string; source: string;
    status: Decision; note: string;
  }>;
  const at = Date.now() - 86400e3;

  doc.components = rows.map((r) => {
    const fingerprint = fpOf(r.name, r.version, r.license); // 回填指纹
    return {
      id: idOf('c'),
      name: r.name,
      version: r.version,
      source: (r.source === '手动' ? '手动' : r.source === 'lockfile' ? 'lockfile' : 'npm') as Component['source'],
      declaredLicense: r.license,
      fingerprint,
      verdict: {
        decision: r.status,
        note: r.note,
        by: '历史数据',
        at,
        basisFp: fingerprint,
        basisBaseline: '升级前', // 基线版本对不上 → 等待按新基线重新确认
      },
    };
  });

  // 回填许可证证据
  const evidence: Evidence[] = doc.components.map((c) => ({
    id: idOf('ev'),
    kind: 'license' as const,
    title: `${c.name}/LICENSE (${c.declaredLicense})`,
    ref: `${c.name} ${c.version}`,
    hash: hashOf(['v1-evidence', c.name, c.version, c.declaredLicense]),
    at,
    by: '迁移器',
  }));
  const links: Record<string, string> = {};
  evidence.forEach((e, i) => { links[e.id] = doc.components[i].id; });

  const mig: Batch = {
    id: idOf('b'),
    kind: 'migration',
    title: `旧数据升级 · ${rows.length} 个依赖（回填指纹与基线）`,
    roundId: idOf('round'),
    by: '迁移器',
    startedAt: Date.now(),
    finishedAt: Date.now(),
    state: 'committed',
    baseRev: doc.rev,
    commitRev: doc.rev + 1,
    items: [],
    materialHash: hashOf(rows),
    parentHash: doc.headHash,
  };
  doc.rev = mig.commitRev!;
  mig.hash = hashOf({ rev: doc.rev, parentHash: mig.parentHash, materialHash: mig.materialHash });
  doc.headHash = mig.hash;
  doc.batches.push(mig);

  localStorage.setItem(EVIDENCE_KEY, JSON.stringify(evidence));
  writeLinks(links);
  return doc;
}

// ---------------------------------------------------------------------------
export class ReviewStore {
  doc: Doc;
  faultEnabled = false;
  private faultPlan = -1; // -1 不注入；K>0 再成功 K 次写入后失败一次；-2 每次都失败
  private listeners = new Set<Listener>();
  private channel: BroadcastChannel | null = null;

  constructor() {
    this.faultEnabled = localStorage.getItem(FAULT_KEY) === '1';
    const raw = localStorage.getItem(DOC_KEY);
    if (raw) {
      try { this.doc = JSON.parse(raw) as Doc; } catch { this.doc = seedDoc(); }
    } else {
      const legacy = localStorage.getItem('license-lens');
      this.doc = legacy ? migrateV1(legacy) : seedDoc();
      if (!legacy) {
        localStorage.setItem(EVIDENCE_KEY, JSON.stringify(seedEvidence()));
        writeLinks(seedEvidenceLinks);
      }
      this.persist(true);
    }
    if (!localStorage.getItem(EVIDENCE_KEY)) {
      localStorage.setItem(EVIDENCE_KEY, JSON.stringify(seedEvidence()));
    }
    if (!localStorage.getItem(LINKS_KEY)) writeLinks(seedEvidenceLinks);

    if (typeof BroadcastChannel !== 'undefined') {
      this.channel = new BroadcastChannel(CH);
      this.channel.onmessage = (e) => {
        // 只接受来自其他标签实例的广播（写入方不携带本实例标记）
        if (e.data?.type === 'committed' && e.data.rev !== this.doc.rev && !e.data.self) {
          this.reloadFromStorage();
        }
      };
    }
    window.addEventListener('storage', (e) => {
      // 主文档键变化 → 重载；LIVE 键变化（他标签中断/恢复）→ 仅同步恢复横幅
      if (e.key === DOC_KEY && e.newValue) this.reloadFromStorage();
      if (e.key === LIVE_KEY) { this.syncLiveRef(); this.emit(); }
    });
    this.syncLiveRef();
  }

  private reloadFromStorage() {
    const raw = localStorage.getItem(DOC_KEY);
    if (raw) {
      try { this.doc = JSON.parse(raw) as Doc; this.syncLiveRef(); this.emit(); } catch { /* ignore */ }
    }
  }

  subscribe(fn: Listener) {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }
  private emit() { this.syncLiveRef(); this.listeners.forEach((fn) => fn()); }

  // LIVE 中的运行/中断批次以易失字段镜像到内存 doc，驱动刷新后的恢复横幅（不持久化）
  private syncLiveRef() {
    const live = this.peekLive();
    const ref = live && (live.batch.state === 'running' || live.batch.state === 'interrupted') ? live.batch.id : null;
    if (this.doc.liveRef !== ref) this.doc.liveRef = ref;
  }
  private peekLive(): LiveBatch | null {
    try {
      const raw = localStorage.getItem(LIVE_KEY);
      return raw ? (JSON.parse(raw) as LiveBatch) : null;
    } catch { return null; }
  }

  // ---- 落盘原语：模拟 fsync 的“写入未确认”——存储层已写入但调用方不能假定成功。
  // 因此故障返回 false 时，调用方必须把该快照当作不可信：rev 不前进、以 LIVE 为准重试。----
  private writeDoc(d: Doc): boolean {
    const { liveRef, ...persisted } = d; // 易失字段不落盘
    void liveRef;
    localStorage.setItem(DOC_KEY, JSON.stringify(persisted));
    // -2（持续失败）只有在故障开关开启时才生效；关闭时视作计划清除
    if (this.faultEnabled && this.faultPlan === -2) return false;
    if (this.faultPlan === 0) {
      this.faultPlan = this.faultEnabled ? -2 : -1;
      return false;
    }
    if (this.faultPlan > 0) this.faultPlan--;
    this.channel?.postMessage({ type: 'committed', rev: d.rev });
    return true;
  }
  private persist(silent = false): boolean {
    if (silent) {
      const { liveRef, ...persisted } = this.doc;
      void liveRef;
      localStorage.setItem(DOC_KEY, JSON.stringify(persisted));
      return true;
    }
    return this.writeDoc(this.doc);
  }

  setFault(on: boolean) {
    this.faultEnabled = on;
    this.faultPlan = on ? -2 : -1;
    localStorage.setItem(FAULT_KEY, on ? '1' : '0');
    this.emit();
  }

  // ---- 证据 ----
  evidenceList(): Evidence[] {
    try { return JSON.parse(localStorage.getItem(EVIDENCE_KEY) || '[]'); } catch { return []; }
  }
  evidenceFor(componentId: string): Evidence[] {
    const links = readLinks();
    return this.evidenceList().filter((e) => links[e.id] === componentId);
  }
  evidenceComponent(evId: string): string | undefined {
    return readLinks()[evId];
  }
  private addEvidence(partial: Omit<Evidence, 'id' | 'at' | 'by'>, componentId: string, by: string, at: number) {
    const all = this.evidenceList();
    const found = all.find((e) => e.hash === partial.hash); // 重试时按内容去重
    if (found) {
      const links = readLinks();
      links[found.id] = componentId;
      writeLinks(links);
      return;
    }
    const ev: Evidence = { ...partial, id: idOf('ev'), at, by };
    all.push(ev);
    localStorage.setItem(EVIDENCE_KEY, JSON.stringify(all));
    const links = readLinks();
    links[ev.id] = componentId;
    writeLinks(links);
  }

  interruptedBatch(): LiveBatch | null {
    try {
      const raw = localStorage.getItem(LIVE_KEY);
      return raw ? (JSON.parse(raw) as LiveBatch) : null;
    } catch { return null; }
  }

  // ============ 纯函数：把一条变更应用到文档 ============
  private apply(doc: Doc, change: Change, by: string, at: number) {
    const b = baselineOf(doc);
    switch (change.t) {
      case 'component': {
        const c: Component = clone(change.component);
        if (!c.fingerprint) c.fingerprint = fpOf(c.name, c.version, c.declaredLicense);
        const existing = doc.components.find((x) => x.id === c.id);
        if (existing) {
          // 包指纹更新：旧裁决保留但 basisFp 失配 → 等待重新确认
          existing.name = c.name; existing.version = c.version;
          existing.source = c.source; existing.declaredLicense = c.declaredLicense;
          existing.fingerprint = c.fingerprint;
        } else {
          doc.components.push(c);
        }
        if (change.evidence) this.addEvidence(change.evidence, c.id, by, at);
        return;
      }
      case 'verdict': {
        const c = doc.components.find((x) => x.id === change.componentId);
        if (!c) return;
        c.verdict = {
          decision: change.decision, note: change.note, by, at,
          basisFp: c.fingerprint, basisBaseline: b.version,
        };
        return;
      }
      case 'reconfirm': {
        const c = doc.components.find((x) => x.id === change.componentId);
        if (!c || !c.verdict) return;
        c.verdict.basisFp = c.fingerprint;
        c.verdict.basisBaseline = b.version;
        c.verdict.reconfirmedAt = at;
        return;
      }
      case 'evidence':
        this.addEvidence(change.ev, change.componentId, by, at);
        return;
      case 'grant': {
        const g: Grant = { ...change.grant, id: change.grantId || idOf('g'), at, by };
        const i = doc.grants.findIndex((x) => x.id === g.id);
        if (i >= 0) doc.grants[i] = g; else doc.grants.push(g);
        return;
      }
      case 'exemption': {
        const x: Exemption = { ...change.ex, id: change.exId || idOf('x'), at, by };
        const i = doc.exemptions.findIndex((e) => e.id === x.id);
        if (i >= 0) doc.exemptions[i] = x; else doc.exemptions.push(x);
        return;
      }
      case 'baseline': {
        const nb: Baseline = { ...change.baseline, id: change.baselineId || idOf('bl'), at, by };
        const i = doc.baselines.findIndex((x) => x.id === nb.id);
        if (i >= 0) doc.baselines[i] = nb; else doc.baselines.push(nb);
        doc.baselineId = nb.id;
        // 基线更新后，旧裁决的 basisBaseline 全部失配 → 等待重新确认（effective 派生）
        return;
      }
    }
  }

  private itemLabel(c: Change): string {
    const name = (id: string) => this.doc.components.find((x) => x.id === id)?.name ?? id;
    switch (c.t) {
      case 'component': return `导入依赖 ${c.component.name}@${c.component.version}`;
      case 'verdict': return `裁决 ${name(c.componentId)}`;
      case 'reconfirm': return `重新确认 ${name(c.componentId)}`;
      case 'evidence': return `补许可证证据 · ${name(c.componentId)}`;
      case 'grant': return `商业授权 · ${c.grant.title}`;
      case 'exemption': return `豁免 · ${name(c.ex.componentId)}`;
      case 'baseline': return `发布基线 ${c.baseline.version}`;
    }
  }

  // 检查点：已应用到 scratch 的条目效果 + 运行中批次，整体落盘。
  // 关键：rev/headHash 保持批次基线（回执未提交，修订号绝不前进），只快照领域数据与进度。
  private checkpoint(scratch: Doc, batch: Batch): boolean {
    const cp: Doc = {
      ...scratch,
      rev: batch.baseRev,
      headHash: batch.parentHash,
      batches: [...this.doc.batches.filter((x) => x.id !== batch.id), { ...batch }],
    };
    return this.writeDoc(cp);
  }

  // ============ 批次保存（逐条应用、逐条 fsync、检查点可恢复） ============
  startBatch(
    kind: Batch['kind'], title: string, changes: Change[], by: string,
    opts?: { roundId?: string; faultAfter?: number },
  ): Batch {
    const items: BatchItem[] = changes.map((c, i) => ({
      key: `${Date.now()}-${i}`, label: this.itemLabel(c), state: 'pending', change: c,
    }));
    const batch: Batch = {
      id: idOf('b'), kind, title, roundId: opts?.roundId ?? idOf('round'), by,
      startedAt: Date.now(), state: 'running', baseRev: this.doc.rev,
      items, materialHash: hashOf(changes), parentHash: this.doc.headHash,
    };
    this.faultPlan = opts?.faultAfter ?? -1;
    localStorage.setItem(LIVE_KEY, JSON.stringify({ batch }));
    return batch;
  }

  saveBatch(
    kind: Batch['kind'], title: string, changes: Change[], by: string,
    opts?: { roundId?: string; faultAfter?: number },
  ): SaveResult {
    if (!changes.length) return { ok: false };
    const live = this.interruptedBatch();
    if (live && (live.batch.state === 'running' || live.batch.state === 'interrupted')) {
      return { ok: false, interrupted: true, diskError: live.batch.diskError, batchId: live.batch.id };
    }
    const batch = this.startBatch(kind, title, changes, by, opts);
    return this.finishBatch(batch, changes);
  }

  private finishBatch(batch: Batch, changes: Change[]): SaveResult {
    // OCC：基线修订号必须仍匹配，否则后到者进争议清单
    if (this.doc.rev !== batch.baseRev) {
      return this.toDispute(batch, changes, 'stale');
    }
    // 同轮次重复保存（两标签保存同一批次）：后到者保留材料并进入争议清单
    const winner = this.doc.batches.find((b) => b.state === 'committed' && b.roundId === batch.roundId);
    if (winner) {
      return this.toDispute(batch, changes, 'same-round', winner.id);
    }

    const scratch = clone(this.doc);
    const at = Date.now();
    let failedAt = -1;
    for (let i = 0; i < batch.items.length; i++) {
      const item = batch.items[i];
      this.apply(scratch, item.change, batch.by, at);
      if (!this.checkpoint(scratch, batch)) { failedAt = i; break; }
      item.state = 'done';
      if (!this.checkpoint(scratch, batch)) { failedAt = i; break; } // 固化完成标记
    }

    if (failedAt >= 0) {
      // 落盘失败：半截依赖已在检查点（storage），但内存基线保持干净；
      // 完整批次留在 LIVE，等待“从完整批次继续”
      const item = batch.items[failedAt];
      item.state = 'failed';
      item.error = 'ENOSPC：写入未确认，条目保留在完整批次中待重试';
      batch.state = 'interrupted';
      batch.diskError = '磁盘写入失败';
      localStorage.setItem(LIVE_KEY, JSON.stringify({ batch }));
      // 内存视图对齐检查点（半截依赖对其他标签与本标签一致可见）
      try {
        const cp = JSON.parse(localStorage.getItem(DOC_KEY) || 'null') as Doc | null;
        if (cp) this.doc = cp;
      } catch { /* 保留内存基线，恢复时以 storage 为准 */ }
      this.emit();
      return { ok: false, interrupted: true, diskError: batch.diskError, batchId: batch.id };
    }
    return this.commitReceipt(batch, changes, scratch);
  }

  // 全部条目完成 → 生成回执（哈希链接上一批），落盘
  private commitReceipt(batch: Batch, changes: Change[], scratch: Doc): SaveResult {
    batch.state = 'committed';
    batch.finishedAt = Date.now();
    batch.commitRev = batch.baseRev + 1;
    batch.items.forEach((i) => { i.state = 'done'; delete i.error; });
    batch.materialHash = hashOf(changes);
    batch.hash = hashOf({ rev: batch.commitRev, parentHash: batch.parentHash, materialHash: batch.materialHash });

    // scratch 是基于批次开始时内存基线的克隆（检查点只写 storage、不污染内存）。
    // 就地把 scratch 的全部领域数据写回 this.doc，保持对象身份稳定（外部引用不悬空）。
    this.doc.baselines = scratch.baselines;
    this.doc.baselineId = scratch.baselineId;
    this.doc.components = scratch.components;
    this.doc.grants = scratch.grants;
    this.doc.exemptions = scratch.exemptions;
    this.doc.batches = [...scratch.batches, batch];
    this.doc.rev = batch.commitRev;
    this.doc.headHash = batch.hash;
    this.doc.disputes = scratch.disputes;
    if (!this.persist()) {
      // 回执落盘未确认：persist 可能已把 rev=2 快照写入存储，但它不可信。
      // 用一份有效的检查点（rev 保持 baseRev、领域数据完整、批次为 interrupted 占位）
      // 覆盖回存储；完整材料留在 LIVE，恢复时幂等重放后重提交回执。
      batch.state = 'interrupted';
      batch.diskError = '回执落盘失败';
      const safe: Doc = {
        ...scratch,
        rev: batch.baseRev,
        headHash: batch.parentHash,
        batches: [...scratch.batches, { ...batch }],
        liveRef: null,
      };
      this.doc = safe;
      // 直接写，不再经过故障注入：检查点必须就位（此时故障已计数过一次）
      const { liveRef, ...safePersisted } = safe;
      void liveRef;
      localStorage.setItem(DOC_KEY, JSON.stringify(safePersisted));
      localStorage.setItem(LIVE_KEY, JSON.stringify({ batch }));
      this.emit();
      return { ok: false, interrupted: true, diskError: batch.diskError, batchId: batch.id };
    }
    localStorage.removeItem(LIVE_KEY);
    this.emit();
    return { ok: true, batchId: batch.id };
  }

  private toDispute(batch: Batch, changes: Change[], kind: 'stale' | 'same-round', winnerId?: string): SaveResult {
    const componentIds = [...new Set(changes.map(changeComponentId).filter(Boolean) as string[])];
    const dispute: Dispute = {
      id: idOf('d'),
      roundId: batch.roundId,
      batchId: batch.id,
      at: Date.now(),
      by: batch.by,
      reason: kind === 'same-round'
        ? `同一审查轮次已由先到批次 …${shortId(winnerId)} 落盘，后到者材料全部保留待裁决`
        : `保存期间基线修订号已从 r${batch.baseRev} 前进到 r${this.doc.rev}，后到者材料全部保留待裁决`,
      baseRev: batch.baseRev,
      winnerRev: this.doc.rev,
      changes: clone(changes), // 后到者材料完整保留
      componentIds,
      status: 'open',
    };
    batch.state = 'disputed';
    batch.finishedAt = Date.now();
    batch.materialHash = hashOf(changes);
    batch.hash = hashOf({ dispute: dispute.id, parentHash: batch.parentHash, materialHash: batch.materialHash });
    this.doc = {
      ...this.doc,
      disputes: [...this.doc.disputes, dispute],
      batches: [...this.doc.batches, batch],
    };
    this.persist(true);
    localStorage.removeItem(LIVE_KEY);
    this.emit();
    return { ok: false, disputeId: dispute.id, conflictBaseRev: this.doc.rev, winnerBatchId: winnerId };
  }

  // ============ 恢复：从完整批次继续，只重试未完成项 ============
  resumeBatch(): SaveResult {
    const live = this.interruptedBatch();
    if (!live || live.batch.state === 'committed') return { ok: false };
    const batch = live.batch;

    if (this.doc.rev !== batch.baseRev) {
      return this.toDispute(batch, batch.items.map((i) => i.change), 'stale');
    }
    const winner = this.doc.batches.find(
      (b) => b.state === 'committed' && b.roundId === batch.roundId && b.id !== batch.id,
    );
    if (winner) {
      return this.toDispute(batch, batch.items.map((i) => i.change), 'same-round', winner.id);
    }

    // 从检查点主表重建干净 scratch：剔除 running 占位、回退 rev/headHash 到批次基线。
    // 已完成条目的领域效果已在检查点中，但所有变更都是幂等的（组件按 id、证据按内容去重），
    // 因此逐条重放即可：done 项重放成无操作、未完成项首次应用，然后统一提交回执。
    const scratch = clone(this.doc);
    scratch.batches = scratch.batches.filter((b) => b.id !== batch.id);
    scratch.rev = batch.baseRev;
    scratch.headHash = batch.parentHash;
    const at = Date.now();
    let failedAt = -1;
    for (let i = 0; i < batch.items.length; i++) {
      const item = batch.items[i];
      if (item.state === 'done') {
        // 已完成项：幂等重放以保证 scratch 完整，但不再消耗落盘次数
        this.apply(scratch, item.change, batch.by, at);
        continue;
      }
      this.apply(scratch, item.change, batch.by, at);
      if (!this.checkpoint(scratch, batch)) { failedAt = i; break; }
      item.state = 'done';
      if (!this.checkpoint(scratch, batch)) { failedAt = i; break; }
    }

    if (failedAt >= 0) {
      const item = batch.items[failedAt];
      item.state = 'failed';
      item.error = 'ENOSPC：重试时写入仍未确认';
      batch.state = 'interrupted';
      batch.diskError = '磁盘写入失败（恢复重试）';
      localStorage.setItem(LIVE_KEY, JSON.stringify({ batch }));
      try {
        const cp = JSON.parse(localStorage.getItem(DOC_KEY) || 'null') as Doc | null;
        if (cp) this.doc = cp;
      } catch { /* keep */ }
      this.emit();
      return { ok: false, interrupted: true, diskError: batch.diskError, batchId: batch.id };
    }
    return this.commitReceipt(batch, batch.items.map((i) => i.change), scratch);
  }

  // ============ 争议裁决 ============
  resolveDispute(disputeId: string, resolution: string, reapply: boolean, by: string) {
    const d = this.doc.disputes.find((x) => x.id === disputeId);
    if (!d || d.status === 'resolved') return;
    if (reapply) {
      // 后到者材料作为新一轮重新落盘（新 roundId，基线已对齐）
      const at = Date.now();
      const scratch = clone(this.doc);
      d.changes.forEach((c) => this.apply(scratch, c, by, at));
      const newRev = this.doc.rev + 1;
      const batch: Batch = {
        id: idOf('b'), kind: 'recovery',
        title: `争议材料重新提交（原批次 …${shortId(d.batchId)}）`,
        roundId: idOf('round'), by, startedAt: at, finishedAt: at,
        state: 'committed', baseRev: this.doc.rev, commitRev: newRev,
        items: d.changes.map((c, i) => ({ key: `${at}-${i}`, label: this.itemLabel(c), state: 'done', change: c })),
        materialHash: hashOf(d.changes), parentHash: this.doc.headHash,
      };
      batch.hash = hashOf({ rev: newRev, parentHash: batch.parentHash, materialHash: batch.materialHash });
      this.doc = {
        ...scratch, rev: newRev, headHash: batch.hash,
        batches: [...scratch.batches, batch],
      };
    }
    d.status = 'resolved';
    d.resolution = resolution;
    d.resolvedAt = Date.now();
    this.persist();
    this.emit();
  }

  // ============ 模拟“另一个标签”的对端提交（真实多标签场景由 storage 事件覆盖） ============
  foreignCommit(kind: Batch['kind'], title: string, changes: Change[], by: string, roundId: string): SaveResult {
    const baseRev = this.doc.rev;
    const at = Date.now();
    const scratch = clone(this.doc);
    changes.forEach((c) => this.apply(scratch, c, by, at));
    const newRev = baseRev + 1;
    const batch: Batch = {
      id: idOf('b'), kind, title, roundId, by, startedAt: at, finishedAt: at,
      state: 'committed', baseRev, commitRev: newRev,
      items: changes.map((c, i) => ({ key: `${at}-${i}`, label: this.itemLabel(c), state: 'done', change: c })),
      materialHash: hashOf(changes), parentHash: this.doc.headHash,
    };
    batch.hash = hashOf({ rev: newRev, parentHash: batch.parentHash, materialHash: batch.materialHash });
    this.doc = { ...scratch, rev: newRev, headHash: batch.hash, batches: [...scratch.batches, batch] };
    this.persist();
    this.emit();
    return { ok: true, batchId: batch.id };
  }

  // ---- 按审计员隔离的暂存草稿（不会互相覆盖主数据）----
  reconfirm(componentId: string, by: string): SaveResult {
    const name = this.doc.components.find((c) => c.id === componentId)?.name ?? componentId;
    return this.saveBatch('review', `重新确认裁决 · ${name}`, [{ t: 'reconfirm', componentId }], by);
  }

  loadDraft(who: string): Change[] {
    try { return JSON.parse(localStorage.getItem(DRAFT_KEY(who)) || '[]'); } catch { return []; }
  }
  saveDraft(who: string, changes: Change[]) {
    localStorage.setItem(DRAFT_KEY(who), JSON.stringify(changes));
    this.emit();
  }
  clearDraft(who: string) {
    localStorage.removeItem(DRAFT_KEY(who));
    this.emit();
  }

  resetAll() {
    localStorage.removeItem(DOC_KEY);
    localStorage.removeItem(LIVE_KEY);
    localStorage.removeItem(EVIDENCE_KEY);
    localStorage.removeItem(LINKS_KEY);
    localStorage.removeItem('license-lens');
    AUDITORS.forEach((a) => localStorage.removeItem(DRAFT_KEY(a)));
    this.doc = seedDoc();
    localStorage.setItem(EVIDENCE_KEY, JSON.stringify(seedEvidence()));
    writeLinks(seedEvidenceLinks);
    this.persist(true);
    this.emit();
  }

  installLegacy() {
    localStorage.removeItem(DOC_KEY);
    localStorage.removeItem(LIVE_KEY);
    localStorage.removeItem(EVIDENCE_KEY);
    localStorage.removeItem(LINKS_KEY);
    localStorage.setItem('license-lens', legacyV1());
    location.reload();
  }
}

export const store = new ReviewStore();
export function useStore(): Doc {
  return useSyncExternalStore(
    store.subscribe.bind(store),
    () => store.doc,
    () => store.doc, // getServerSnapshot：SSR/首帧快照
  );
}
