// License Lens 审查引擎：依赖、证据、基线、批次回执、争议构成可恢复审查链
import { batchId, componentId, evidenceId, fingerprintOf } from './digest';
import type { ParsedDep } from './lockfile';
import { defaultBaseline, policyDecision, policyNote } from './policy';
import type { PersistenceAdapter } from './persistence';
import { COVERING_KINDS, coveringEvidence } from './selectors';
import type {
  Auditor,
  BaselineRule,
  BatchItem,
  BatchItemStatus,
  BatchReceipt,
  BatchStatus,
  Dispute,
  Evidence,
  EvidenceDraft,
  StoreState,
  Verdict,
  VerdictKind,
} from './types';

export interface ScanResult {
  receipt: BatchReceipt;
  interrupted: boolean;
  failure?: string;
}

export interface EvidenceSaveResult {
  receipt: BatchReceipt;
  conflict: boolean;
  disputeId?: string;
  failure?: string;
}

export interface RetryResult {
  receipt: BatchReceipt;
  stillPending: number;
  failure?: string;
}

export interface DecideResult {
  verdict: Verdict;
  rev: number;
  failure?: string;
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function freshState(now: string): StoreState {
  return {
    schemaVersion: 2,
    rev: 0,
    components: {},
    evidence: {},
    verdicts: {},
    baseline: defaultBaseline(now),
    batches: {},
    disputes: {},
  };
}

/** v1 旧数据升级：回填组件指纹与当前基线版本；旧裁决标 legacy，等待重新确认 */
export function migrateLegacy(
  legacy: unknown,
  now: string,
): { state: StoreState; migrated: number } | null {
  if (!Array.isArray(legacy)) return null;
  const state = freshState(now);
  let migrated = 0;
  for (const raw of legacy as Array<Record<string, unknown>>) {
    const name = typeof raw.name === 'string' ? raw.name : '';
    if (!name) continue;
    const version = typeof raw.version === 'string' ? raw.version : '0.0.0';
    const license = typeof raw.license === 'string' ? raw.license : 'UNKNOWN';
    const ecosystem = raw.source === '手动' ? 'manual' : 'npm';
    const id = componentId(ecosystem, name);
    const fp = fingerprintOf({ name, version, license, ecosystem });
    const oldDecision: VerdictKind =
      raw.status === 'ok' ? 'approved' : raw.status === 'risk' ? 'rejected' : 'review';
    state.components[id] = {
      id,
      name,
      version,
      ecosystem,
      license,
      fingerprint: fp,
      introducedBatch: 'migration-v1',
      updatedAt: now,
    };
    state.verdicts[id] = {
      componentId: id,
      fingerprint: fp, // 回填指纹
      baselineVersion: state.baseline.version, // 回填基线版本
      decision: oldDecision,
      note: typeof raw.note === 'string' ? raw.note : '迁移自 v1 数据',
      decidedBy: 'v1-import',
      decidedAt: now,
      legacy: true, // 仍需重新确认
    };
    migrated += 1;
  }
  if (migrated === 0) return null;
  state.migratedAt = now;
  return { state, migrated };
}

const MAX_ATTEMPTS = 3;

export class LensEngine {
  state: StoreState;
  /** 未决批次：已开始但尚未完整提交（含落盘失败/扫描中断），保留完整负载 */
  private inflight = new Map<string, BatchReceipt>();
  private listeners = new Set<() => void>();
  lastError: string | null = null;

  constructor(
    private adapter: PersistenceAdapter,
    private clock: () => Date = () => new Date(),
  ) {
    const loaded = adapter.load();
    if (loaded && loaded.schemaVersion === 2) {
      this.state = loaded;
    } else {
      this.state = freshState(this.now());
    }
    this.adapter.subscribe((remote) => this.onRemote(remote));
  }

  now(): string {
    return this.clock().toISOString();
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  private emit() {
    this.listeners.forEach((cb) => cb());
  }

  /** 启动时执行：旧数据升级回填；未决批次自动重试 */
  bootstrap(): { migrated: number; resumed: number } {
    let migrated = 0;
    if (
      Object.keys(this.state.components).length === 0 &&
      this.adapter.loadLegacy
    ) {
      const legacy = this.adapter.loadLegacy();
      const result = migrateLegacy(legacy, this.now());
      if (result) {
        try {
          const committed = this.flush(result.state, result.state.rev);
          this.state = committed;
          migrated = result.migrated;
          this.adapter.clearLegacy?.();
        } catch (err) {
          // 首次落盘即失败：仍保留在内存，稍后从完整批次/数据继续重试
          this.state = result.state;
          this.lastError = (err as Error).message;
        }
      }
    }
    let resumed = 0;
    for (const b of Object.values(this.state.batches)) {
      if (b.status === 'running' || b.status === 'partial' || b.status === 'failed') {
        if (b.items.some((i) => i.status === 'pending' || i.status === 'failed')) {
          resumed += 1;
          this.inflight.set(b.id, b);
        }
      }
    }
    if (resumed > 0 || migrated > 0) this.emit();
    return { migrated, resumed };
  }

  // ---------- 底层持久化（CAS） ----------

  private flush(base: StoreState, expectedRev: number): StoreState {
    const next = clone(base);
    next.rev = expectedRev + 1;
    const res = this.adapter.commit(next, expectedRev);
    if (!res.ok) throw new CasError(res.current);
    return res.state;
  }

  /** 基于磁盘最新状态重放内存中的增量（重放未决批次的已完成项会自然跳过） */
  private rebase(
    mutate: (s: StoreState) => void,
    extraBases: BatchReceipt[] = [],
  ): StoreState {
    let base = clone(this.adapter.read() ?? this.state);
    // 合并本地未决批次（其他标签看不到的半截依赖/材料）
    for (const b of [...this.inflight.values(), ...extraBases]) {
      base.batches[b.id] = clone(b);
    }
    mutate(base);
    return base;
  }

  private onRemote(remote: StoreState) {
    // 存在未决写入时不直接覆盖（本地有半截批次），只发出提示；重试时再合并
    if (this.inflight.size > 0) {
      this.emit();
      return;
    }
    this.state = remote;
    this.emit();
  }

  // ---------- 锁文件扫描（逐项批次，可中断/可恢复） ----------

  startScan(
    deps: ParsedDep[],
    auditor: Auditor,
    opts: { interruptAfter?: number } = {},
  ): ScanResult {
    const nowMs = this.clock().getTime();
    const id = batchId(nowMs, `scan:${auditor.id}:${deps.length}`);
    const items: BatchItem[] = deps.map((d, i) => ({
      id: `${id}#${i}`,
      type: 'scan-component' as const,
      componentId: componentId(d.ecosystem, d.name),
      payload: d,
      status: 'pending' as BatchItemStatus,
      attempts: 0,
    }));
    const receipt: BatchReceipt = {
      id,
      label: `锁文件扫描 · ${deps.length} 个依赖`,
      startedBy: auditor.id,
      startedAt: this.now(),
      status: 'running',
      baseRev: this.state.rev,
      items,
    };

    // 登记完整批次回执后再逐项应用 —— 中断后凭回执继续
    let working: StoreState;
    try {
      working = this.rebase((s) => {
        s.batches[id] = clone(receipt);
      });
      working = this.flush(working, working.rev);
    } catch (err) {
      if (err instanceof CasError) return this.retryScanAfterCas(receipt, auditor, opts, err);
      // 登记回执落盘失败：完整批次保留在内存，稍后重试
      receipt.status = 'failed';
      this.state = { ...this.state, batches: { ...this.state.batches, [id]: clone(receipt) } };
      this.inflight.set(id, clone(receipt));
      this.lastError = (err as Error).message;
      this.emit();
      return { receipt: clone(receipt), interrupted: false, failure: this.lastError ?? undefined };
    }

    this.state = working;
    this.inflight.set(id, clone(receipt));
    this.lastError = null;

    let interrupted = false;
    const limit = opts.interruptAfter ?? items.length;
    let i = 0;
    for (; i < items.length; i++) {
      if (i >= limit) {
        interrupted = true;
        break;
      }
      const err = this.applyItem(id, items[i]);
      if (err) {
        const failedReceipt = clone(this.inflight.get(id)!);
        failedReceipt.status = 'failed';
        try {
          this.persistReceiptOnly(failedReceipt);
        } catch {
          /* 失败状态尽力落盘，内存副本仍可恢复 */
        }
        this.lastError = err;
        return { receipt: clone(this.inflight.get(id) ?? failedReceipt), interrupted: false, failure: err };
      }
    }
    const cur = clone(this.inflight.get(id)!);
    if (interrupted) {
      cur.status = 'partial';
      this.persistReceiptOnly(cur);
    } else {
      cur.status = 'committed';
      cur.finishedAt = this.now();
      cur.finalRev = this.state.rev;
      this.persistReceiptOnly(cur);
      this.inflight.delete(id);
    }
    this.emit();
    return { receipt: cur, interrupted, failure: interrupted ? undefined : undefined };
  }

  private retryScanAfterCas(
    receipt: BatchReceipt,
    _auditor: Auditor,
    opts: { interruptAfter?: number },
    casErr: CasError,
  ): ScanResult {
    // 少见路径：登记时被并发提交抢先。基于磁盘修订重建 baseRev 后重走一次
    receipt.baseRev = casErr.current ? casErr.current.rev : receipt.baseRev;
    this.lastError = null;
    return this.startScan(
      receipt.items.map((i) => i.payload as ParsedDep),
      { id: receipt.startedBy, name: receipt.startedBy, initials: '' },
      opts,
    );
  }

  /** 仅更新回执（状态/项进度），冲突时重放未决批次 */
  private persistReceiptOnly(receipt: BatchReceipt): void {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        let working = this.rebase((s) => {
          s.batches[receipt.id] = clone(receipt);
        });
        working = this.flush(working, working.rev);
        this.state = working;
        return;
      } catch (err) {
        if (!(err instanceof CasError)) throw err;
      }
    }
    throw new Error('回执状态多次提交冲突');
  }

  /** 应用一个批次项（组件 upsert / 证据保存等），每项一次原子落盘，天然幂等 */
  private applyItem(batchDbId: string, item: BatchItem): string | null {
    item.attempts += 1;
    try {
      let working: StoreState;
      if (item.type === 'scan-component') {
        const d = item.payload as ParsedDep;
        const id = componentId(d.ecosystem, d.name);
        working = this.rebase((s) => {
          const prev = s.components[id];
          s.components[id] = {
            id,
            name: d.name,
            version: d.version,
            ecosystem: d.ecosystem,
            license: d.license,
            fingerprint: d.fingerprint,
            introducedBatch: prev?.introducedBatch ?? batchDbId,
            updatedAt: this.now(),
          };
          const r = s.batches[batchDbId];
          const target = r?.items.find((x) => x.id === item.id);
          if (target) {
            target.status = 'done';
            target.attempts = item.attempts;
            target.error = undefined;
          }
        });
      } else if (item.type === 'save-evidence') {
        const d = item.payload as EvidenceDraft & { addedBy?: string; addedAt?: string };
        working = this.rebase((s) => {
          const ev: Evidence = {
            id: evidenceId(d.componentId, d.kind, d.title),
            componentId: d.componentId,
            kind: d.kind,
            title: d.title,
            detail: d.detail,
            contact: d.contact,
            attachmentName: d.attachmentName,
            validUntil: d.validUntil,
            addedBy: d.addedBy ?? 'recovery',
            addedAt: d.addedAt ?? this.now(),
            batchId: batchDbId,
          };
          s.evidence[ev.id] = ev; // 幂等：同标识证据覆盖更新
          const target = s.batches[batchDbId]?.items.find((x) => x.id === item.id);
          if (target) {
            target.status = 'done';
            target.attempts = item.attempts;
            target.error = undefined;
          }
        });
      } else {
        item.status = 'failed';
        item.error = '不可重试的批次项类型';
        return item.error;
      }
      working = this.flush(working, working.rev);
      item.status = 'done';
      item.error = undefined;
      this.state = working;
      this.syncInflight(batchDbId);
      return null;
    } catch (err) {
      if (err instanceof CasError) {
        // 被其他标签抢先：基于新状态再试
        if (item.attempts < MAX_ATTEMPTS) {
          return this.applyItem(batchDbId, item);
        }
        item.status = 'failed';
        item.error = '修订冲突重试耗尽';
      } else {
        // 落盘失败：状态回滚为 pending（保留 attempts），稍后从完整批次继续重试
        item.status = 'pending';
        item.error = (err as Error).message;
      }
      this.syncInflight(batchDbId);
      // 尽力持久化半截进度（失败可忽略，内存副本仍保留）
      this.bestEffortReceiptPersist(batchDbId);
      return item.error ?? '未知错误';
    }
  }

  private bestEffortReceiptPersist(id: string) {
    const receipt = this.inflight.get(id);
    if (!receipt) return;
    try {
      this.persistReceiptOnly(clone(receipt));
    } catch {
      /* 保留内存副本 */
    }
  }

  private syncInflight(id: string) {
    const receipt = this.inflight.get(id);
    if (!receipt) return;
    const durable = this.state.batches[id];
    // 以磁盘中的项状态为准（含本次 apply 写入的 done/attempts 标记）；
    // 磁盘缺失（登记即失败）时同步内存中刚更新的项状态
    const source = durable ? durable.items : receipt.items;
    const byId = new Map(source.map((x) => [x.id, x]));
    for (const item of receipt.items) {
      const s = byId.get(item.id);
      if (s) {
        item.status = s.status;
        item.attempts = s.attempts;
        item.error = s.error;
      }
    }
    if (durable) receipt.status = durable.status;
  }

  // ---------- 证据保存（材料批次；后到者进争议清单） ----------

  saveEvidence(
    drafts: EvidenceDraft[],
    auditor: Auditor,
    options: { forceLateArrival?: boolean; readRev?: number } = {},
  ): EvidenceSaveResult {
    const nowMs = this.clock().getTime();
    const id = batchId(nowMs, `ev:${auditor.id}:${drafts.length}`);
    const componentIds = [...new Set(drafts.map((d) => d.componentId))];
    const items: BatchItem[] = drafts.map((d, i) => ({
      id: `${id}#${i}`,
      type: 'save-evidence',
      componentId: d.componentId,
      payload: { ...d, addedBy: auditor.id, addedAt: this.now(), batchId: id },
      status: 'pending',
      attempts: 0,
    }));
    // readRev = 审计员打开材料编辑/读取组件时的修订号；缺省以当前状态为准
    const receipt: BatchReceipt = {
      id,
      label: `保存许可材料 · ${drafts.length} 份`,
      startedBy: auditor.id,
      startedAt: this.now(),
      status: 'running',
      baseRev: options.readRev ?? this.state.rev,
      items,
    };

    // 争议判定：本批次读取点（readRev）之后若有他人对相同组件的证据先落盘，则为后到者
    let conflictInfo: { earlier: BatchReceipt | undefined; laterBy: string } | null = null;
    if (options.forceLateArrival) {
      conflictInfo = {
        earlier: this.findEarlierEvidenceBatch(componentIds, id),
        laterBy: auditor.id,
      };
    } else {
      const disk = this.adapter.read();
      if (disk) {
        const earlier = this.earlierConflictingBatch(disk, receipt, componentIds);
        if (earlier) conflictInfo = { earlier, laterBy: auditor.id };
      }
    }

    if (conflictInfo) {
      return this.commitDisputed(receipt, conflictInfo.earlier, componentIds, auditor);
    }

    return this.commitEvidence(receipt, items, auditor);
  }

  private findEarlierEvidenceBatch(componentIds: string[], selfId: string) {
    return Object.values(this.state.batches)
      .filter(
        (b) =>
          b.id !== selfId &&
          b.items.some(
            (i) =>
              i.type === 'save-evidence' &&
              i.componentId &&
              componentIds.includes(i.componentId),
          ),
      )
      .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))[0];
  }

  /**
   * 并发分叉检测：本批次在 baseRev 读取数据，若磁盘在此之后（finalRev > baseRev）
   * 已提交了其他审计员覆盖相同组件的证据批次，则本批次为「后到者」。
   * 仅扫描逐项 upsert、人工裁决等可交换操作走 rebase 重放；证据保存必须先经此判定。
   */
  private earlierConflictingBatch(
    disk: StoreState,
    receipt: BatchReceipt,
    componentIds: string[],
  ): BatchReceipt | undefined {
    return Object.values(disk.batches)
      .filter(
        (b) =>
          b.id !== receipt.id &&
          b.startedBy !== receipt.startedBy &&
          b.status === 'committed' &&
          (b.finalRev ?? 0) > receipt.baseRev &&
          b.items.some(
            (i) =>
              i.type === 'save-evidence' &&
              i.componentId &&
              componentIds.includes(i.componentId),
          ),
      )
      .sort((a, b) => (b.finalRev ?? 0) - (a.finalRev ?? 0))[0];
  }

  private commitEvidence(
    receipt: BatchReceipt,
    items: BatchItem[],
    auditor: Auditor,
  ): EvidenceSaveResult {
    const componentIds = [...new Set(items.map((i) => i.componentId!))];

    // 提交前先对照磁盘最新状态检测并发分叉（rebase 会读取最新 rev，故必须在此显式判定）
    const disk = this.adapter.read();
    if (disk) {
      const earlier = this.earlierConflictingBatch(disk, receipt, componentIds);
      if (earlier) {
        return this.commitDisputed(receipt, earlier, componentIds, auditor);
      }
    }

    try {
      let working = this.rebase(
        (s) => {
          for (const item of items) {
            const d = item.payload as EvidenceDraft & { addedBy: string; addedAt: string; batchId: string };
            const ev: Evidence = {
              id: evidenceId(d.componentId, d.kind, d.title),
              componentId: d.componentId,
              kind: d.kind,
              title: d.title,
              detail: d.detail,
              contact: d.contact,
              attachmentName: d.attachmentName,
              validUntil: d.validUntil,
              addedBy: d.addedBy,
              addedAt: d.addedAt,
              batchId: receipt.id,
            };
            // 幂等：同标识证据覆盖更新（重试安全）
            s.evidence[ev.id] = ev;
            item.status = 'done';
            item.attempts += 1;
            item.error = undefined;
          }
          const done: BatchReceipt = {
            ...clone(receipt),
            status: 'committed',
            finishedAt: this.now(),
            items: clone(items),
          };
          done.finalRev = s.rev + 1; // flush 后修订号 +1
          s.batches[receipt.id] = done;
        },
        [receipt],
      );
      working = this.flush(working, working.rev);
      this.state = working;
      this.inflight.delete(receipt.id);
      this.lastError = null;
      this.emit();
      return { receipt: clone(working.batches[receipt.id]), conflict: false };
    } catch (err) {
      if (err instanceof CasError) {
        // CAS 失败：重读磁盘并再次做并发分叉判定
        const disk = err.current ?? this.adapter.read();
        const earlier = disk
          ? this.earlierConflictingBatch(disk, receipt, componentIds)
          : undefined;
        if (earlier) {
          return this.commitDisputed(receipt, earlier, componentIds, auditor);
        }
        // 无人竞争同组件材料：幂等重放提交
        return this.commitEvidence(
          receipt,
          items.map((i) => ({ ...i, attempts: i.attempts + 1 })),
          auditor,
        );
      }
      // 落盘失败：完整批次进入未决，稍后从完整批次继续重试
      items.forEach((i) => {
        i.status = 'pending';
      });
      const failed: BatchReceipt = { ...clone(receipt), status: 'failed', items: clone(items) };
      this.parkInflight(failed);
      this.lastError = (err as Error).message;
      this.emit();
      return { receipt: failed, conflict: false, failure: this.lastError ?? undefined };
    }
  }

  private commitDisputed(
    receipt: BatchReceipt,
    earlier: BatchReceipt | undefined,
    componentIds: string[],
    auditor: Auditor,
  ): EvidenceSaveResult {
    receipt.items.forEach((i) => {
      i.status = 'conflict';
      i.error = '后到保存：材料保留于争议清单，未覆盖先到者数据';
    });
    const dispute: Dispute = {
      id: `dispute:${receipt.id.split(':').slice(1).join(':')}`,
      batchId: receipt.id,
      componentIds,
      reason: '两个标签同时保存同一批次，后到者材料与先到裁决冲突，等待人工合并',
      earlierBy: earlier?.startedBy ?? '另一位审计员',
      laterBy: auditor.id,
      keptBy: earlier?.startedBy ?? '另一位审计员',
      createdAt: this.now(),
      status: 'open',
      laterLabel: receipt.label,
      laterItems: clone(receipt.items),
    };
    const disputed: BatchReceipt = {
      ...clone(receipt),
      status: 'disputed',
      finishedAt: this.now(),
      disputeId: dispute.id,
    };

    try {
      let working = this.rebase((s) => {
        s.disputes[dispute.id] = dispute;
        s.batches[receipt.id] = clone(disputed);
      });
      working = this.flush(working, working.rev);
      this.state = working;
      this.inflight.delete(receipt.id);
      this.lastError = null;
      this.emit();
      return { receipt: clone(disputed), conflict: true, disputeId: dispute.id };
    } catch (err) {
      if (err instanceof CasError) {
        // 争议登记本身冲突：重读再试一次
        return this.commitDisputed(receipt, earlier, componentIds, auditor);
      }
      this.parkInflight(disputed);
      this.lastError = (err as Error).message;
      this.emit();
      return { receipt: disputed, conflict: true, disputeId: dispute.id, failure: this.lastError ?? undefined };
    }
  }

  // ---------- 争议处理：合并（后到材料补入）或舍弃 ----------

  resolveDispute(
    disputeId: string,
    action: 'merge' | 'discard',
    auditor: Auditor,
    note: string,
  ): EvidenceSaveResult | null {
    const dispute = this.state.disputes[disputeId];
    if (!dispute || dispute.status !== 'open') return null;
    const nowMs = this.clock().getTime();
    const id = batchId(nowMs, `resolve:${disputeId}:${action}`);
    const receipt: BatchReceipt = {
      id,
      label: action === 'merge' ? `合并争议材料 · ${dispute.laterLabel}` : `舍弃争议材料 · ${dispute.laterLabel}`,
      startedBy: auditor.id,
      startedAt: this.now(),
      status: 'running',
      baseRev: this.state.rev,
      items: dispute.laterItems.map((it, i) => ({
        ...clone(it),
        id: `${id}#${i}`,
        status: 'pending' as BatchItemStatus,
        attempts: 0,
        error: undefined,
      })),
    };

    try {
      let working = this.rebase((s) => {
        if (action === 'merge') {
          for (const item of receipt.items) {
            const d = item.payload as EvidenceDraft & { addedBy: string; addedAt: string };
            const ev: Evidence = {
              id: evidenceId(d.componentId, d.kind, d.title),
              componentId: d.componentId,
              kind: d.kind,
              title: d.title,
              detail: d.detail,
              contact: d.contact,
              attachmentName: d.attachmentName,
              validUntil: d.validUntil,
              addedBy: d.addedBy,
              addedAt: this.now(),
              batchId: id,
            };
            s.evidence[ev.id] = ev;
            item.status = 'done';
          }
        } else {
          receipt.items.forEach((i) => {
            i.status = 'done';
            i.error = '材料已舍弃';
          });
        }
        s.disputes[disputeId] = {
          ...s.disputes[disputeId],
          status: action === 'merge' ? 'merged' : 'discarded',
          resolvedAt: this.now(),
          resolvedBy: auditor.id,
          resolutionNote: note,
        };
        // 原后到批次标记已处理
        const origin = s.batches[dispute.batchId];
        if (origin) origin.status = action === 'merge' ? 'committed' : 'failed';
        const done: BatchReceipt = {
          ...clone(receipt),
          status: 'committed',
          finishedAt: this.now(),
        };
        s.batches[id] = done;
      });
      working = this.flush(working, working.rev);
      this.state = working;
      this.inflight.delete(dispute.batchId);
      this.emit();
      return { receipt: clone(this.state.batches[id]), conflict: false };
    } catch (err) {
      if (err instanceof CasError) {
        return this.resolveDispute(disputeId, action, auditor, note);
      }
      const failed = { ...clone(receipt), status: 'failed' as BatchStatus };
      this.parkInflight(failed);
      this.lastError = (err as Error).message;
      this.emit();
      return { receipt: failed, conflict: false, failure: this.lastError ?? undefined };
    }
  }

  // ---------- 策略基线发布：旧裁决等待重新确认 ----------

  publishBaseline(
    rules: BaselineRule[],
    auditor: Auditor,
    note: string,
  ): { rev: number; version: number; failure?: string } {
    try {
      let working = this.rebase((s) => {
        s.baseline = {
          version: s.baseline.version + 1,
          publishedAt: this.now(),
          publishedBy: auditor.id,
          rules: clone(rules),
        };
        // 基线版本更新：所有旧裁决的 baselineVersion 不再匹配 → 等待重新确认
        const id = batchId(this.clock().getTime(), `baseline:${auditor.id}`);
        const receipt: BatchReceipt = {
          id,
          label: `发布策略基线 v${s.baseline.version}${note ? ` · ${note}` : ''}`,
          startedBy: auditor.id,
          startedAt: this.now(),
          finishedAt: this.now(),
          status: 'committed',
          baseRev: s.rev,
          items: [
            { id: `${id}#0`, type: 'publish-baseline', payload: { version: s.baseline.version }, status: 'done', attempts: 1 },
          ],
        };
        s.batches[id] = receipt;
      });
      working = this.flush(working, working.rev);
      this.state = working;
      this.lastError = null;
      this.emit();
      return { rev: working.rev, version: working.baseline.version };
    } catch (err) {
      if (err instanceof CasError) return this.publishBaseline(rules, auditor, note);
      this.lastError = (err as Error).message;
      this.emit();
      return { rev: this.state.rev, version: this.state.baseline.version, failure: this.lastError ?? undefined };
    }
  }

  // ---------- 人工裁决 ----------

  decide(
    componentDbId: string,
    decision: VerdictKind,
    note: string,
    auditor: Auditor,
  ): DecideResult | null {
    const comp = this.state.components[componentDbId];
    if (!comp) return null;
    const verdict: Verdict = {
      componentId: componentDbId,
      fingerprint: comp.fingerprint, // 绑定当前指纹
      baselineVersion: this.state.baseline.version, // 绑定当前基线
      decision,
      note,
      decidedBy: auditor.id,
      decidedAt: this.now(),
    };
    try {
      let working = this.rebase((s) => {
        s.verdicts[componentDbId] = verdict;
      });
      working = this.flush(working, working.rev);
      this.state = working;
      this.lastError = null;
      this.emit();
      return { verdict: clone(verdict), rev: working.rev };
    } catch (err) {
      if (err instanceof CasError) {
        const retried = this.decide(componentDbId, decision, note, auditor);
        if (retried) return retried;
      }
      this.lastError = (err as Error).message;
      this.emit();
      return { verdict: clone(verdict), rev: this.state.rev, failure: this.lastError ?? undefined };
    }
  }

  // ---------- 从完整批次继续：重试未完成项 ----------

  retryUnfinished(batchDbId?: string): RetryResult[] {
    const targets = [...this.inflight.values()].filter(
      (b) => !batchDbId || b.id === batchDbId,
    );
    const results: RetryResult[] = [];
    for (const receipt of targets) {
      results.push(this.retryOne(receipt.id));
    }
    if (results.length === 0 && batchDbId) {
      // 页面重载后：inflight 已在 bootstrap 重建
      const durable = this.state.batches[batchDbId];
      if (durable) results.push(this.retryOne(batchDbId));
    }
    return results;
  }

  retryAll(): RetryResult[] {
    const ids = new Set<string>([...this.inflight.keys()]);
    for (const b of Object.values(this.state.batches)) {
      if (
        (b.status === 'running' || b.status === 'partial' || b.status === 'failed') &&
        b.items.some((i) => i.status === 'pending' || i.status === 'failed')
      ) {
        ids.add(b.id);
      }
    }
    const out: RetryResult[] = [];
    for (const id of ids) out.push(this.retryOne(id));
    return out;
  }

  private retryOne(id: string): RetryResult {
    let receipt =
      clone(this.inflight.get(id)) ?? clone(this.state.batches[id]);
    if (!receipt) throw new Error('批次不存在');
    this.inflight.set(id, receipt);

    if (receipt.status === 'disputed') {
      return { receipt, stillPending: 0 };
    }

    // 若磁盘尚无该批次（登记回执时就失败），先补登记完整批次
    if (!this.adapter.read()?.batches[id]) {
      try {
        let working = this.rebase((s) => {
          s.batches[id] = clone(receipt);
        });
        working = this.flush(working, working.rev);
        this.state = working;
      } catch (err) {
        if (!(err instanceof CasError)) {
          this.lastError = (err as Error).message;
          this.emit();
          return { receipt, stillPending: this.countPending(receipt), failure: this.lastError ?? undefined };
        }
      }
    }

    let failure: string | undefined;
    // 从完整批次继续，仅重试未完成项（done 跳过，天然幂等）
    for (const item of receipt.items) {
      if (item.status === 'done' || item.status === 'conflict') continue;
      const err = this.applyItem(id, item);
      if (err) {
        failure = err;
        break;
      }
    }

    receipt = clone(this.inflight.get(id) ?? this.state.batches[id]);
    const stillPending = this.countPending(receipt);
    if (!failure && stillPending === 0 && receipt.status !== 'disputed') {
      receipt.status = 'committed';
      receipt.finishedAt = this.now();
      try {
        this.persistReceiptOnly(receipt);
        this.inflight.delete(id);
      } catch (err) {
        failure = (err as Error).message;
      }
    } else if (failure) {
      receipt.status = 'failed';
      try {
        this.persistReceiptOnly(receipt);
      } catch {
        /* 进度仍在内存中保留 */
      }
    } else if (stillPending > 0 && receipt.status === 'running') {
      receipt.status = 'partial';
      try {
        this.persistReceiptOnly(receipt);
      } catch {
        /* ignore */
      }
    }
    if (failure) this.lastError = failure;
    this.emit();
    return { receipt: clone(receipt), stillPending, failure };
  }

  private countPending(b: BatchReceipt): number {
    return b.items.filter((i) => i.status === 'pending' || i.status === 'failed').length;
  }

  private parkInflight(receipt: BatchReceipt) {
    this.inflight.set(receipt.id, clone(receipt));
    // 尽力把半截状态落盘；失败也保留在内存
    try {
      let working = this.rebase((s) => {
        const existing = s.batches[receipt.id];
        s.batches[receipt.id] = existing
          ? { ...clone(existing), status: receipt.status, items: clone(receipt.items) }
          : clone(receipt);
      });
      working = this.flush(working, working.rev);
      this.state = working;
    } catch (err) {
      if (err instanceof CasError) {
        // 冲突时递归重试一次落盘
        try {
          let working = this.rebase((s) => {
            s.batches[receipt.id] = clone(receipt);
          });
          working = this.flush(working, working.rev);
          this.state = working;
        } catch {
          /* 保留内存副本 */
        }
      }
    }
  }

  // ---------- 查询辅助 ----------

  inflightCount(): number {
    let n = 0;
    for (const b of this.inflight.values()) {
      if (b.status === 'disputed' || b.status === 'committed') continue;
      n += this.countPending(b);
    }
    return n;
  }

  /** 组件的有效覆盖（UI 便捷接口） */
  coversFor(componentDbId: string) {
    return coveringEvidence(this.state, componentDbId);
  }

  policySuggestion(license: string): VerdictKind {
    return policyDecision(this.state.baseline, license);
  }

  policyNoteText(license: string): string {
    return policyNote(this.state.baseline, license);
  }

  hasCoveringKindsInfo(): typeof COVERING_KINDS {
    return COVERING_KINDS;
  }

  /** 演示/演练：接下来 n 次物理写入失败，用于验证从完整批次继续 */
  injectDiskFailures(n: number) {
    this.adapter.setFailNext(n);
  }
}

class CasError extends Error {
  constructor(public current: StoreState | null) {
    super('修订号冲突（其他标签已先提交）');
    this.name = 'CasError';
  }
}
