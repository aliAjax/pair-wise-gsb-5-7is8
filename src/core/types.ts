// License Lens —— 可恢复审查链核心类型

export type VerdictKind = 'approved' | 'review' | 'rejected';

export type EvidenceKind =
  | 'commercial-license' // 商业授权
  | 'exemption' // 法务豁免
  | 'license-text' // 许可证原文/通告存档
  | 'purchase-receipt'; // 采购凭证

/** 策略基线中的单条许可证规则 */
export interface BaselineRule {
  license: string;
  decision: VerdictKind;
  label: string;
  note: string;
}

/** 策略基线：版本化，发布新版本后旧裁决等待重新确认 */
export interface Baseline {
  version: number;
  publishedAt: string;
  publishedBy: string;
  rules: BaselineRule[];
}

/** 被审查组件（依赖），fingerprint 为内容指纹 */
export interface Component {
  id: string; // 确定性标识，如 npm:react
  name: string;
  version: string;
  ecosystem: string;
  license: string; // 锁文件/元数据声明的许可证
  fingerprint: string; // 基于 name@version + license + ecosystem
  introducedBatch: string;
  updatedAt: string;
}

/** 许可证据：授权与豁免按 componentId 覆盖对应组件 */
export interface Evidence {
  id: string;
  componentId: string;
  kind: EvidenceKind;
  title: string;
  detail: string;
  contact?: string;
  attachmentName?: string;
  validUntil?: string; // 可选有效期，过期后不再覆盖
  addedBy: string;
  addedAt: string;
  batchId: string;
}

/** 依赖裁决：仅在指纹与基线版本均匹配时有效 */
export interface Verdict {
  componentId: string;
  fingerprint: string;
  baselineVersion: number;
  decision: VerdictKind;
  note: string;
  decidedBy: string;
  decidedAt: string;
  legacy?: boolean; // v1 数据迁移而来，等待重新确认
}

export type BatchOpType =
  | 'scan-component' // 锁文件扫描逐项
  | 'save-evidence' // 保存许可材料
  | 'publish-baseline' // 发布策略基线
  | 'resolve-dispute'; // 处理争议

export type BatchItemStatus = 'pending' | 'done' | 'failed' | 'conflict';

export interface BatchItem {
  id: string;
  type: BatchOpType;
  componentId?: string;
  payload: unknown;
  status: BatchItemStatus;
  attempts: number;
  error?: string;
}

export type BatchStatus = 'running' | 'partial' | 'committed' | 'failed' | 'disputed';

/** 批次回执：完整保留未完成项的负载，支持中断/落盘失败后继续 */
export interface BatchReceipt {
  id: string;
  label: string;
  startedBy: string;
  startedAt: string;
  finishedAt?: string;
  status: BatchStatus;
  baseRev: number; // 批次开始时的存储修订号
  finalRev?: number; // 批次最终落盘的修订号
  items: BatchItem[];
  disputeId?: string;
}

export interface Dispute {
  id: string;
  batchId: string; // 后到者的批次
  componentIds: string[];
  reason: string;
  earlierBy: string;
  laterBy: string;
  keptBy: string; // 先到者：其材料保留为有效证据
  createdAt: string;
  status: 'open' | 'merged' | 'discarded';
  laterLabel: string;
  laterItems: BatchItem[]; // 后到者材料原样保留
  resolvedAt?: string;
  resolvedBy?: string;
  resolutionNote?: string;
}

/** 持久化文档；rev 为单调修订号，用于跨标签冲突检测（CAS） */
export interface StoreState {
  schemaVersion: 2;
  rev: number;
  components: Record<string, Component>;
  evidence: Record<string, Evidence>;
  verdicts: Record<string, Verdict>;
  baseline: Baseline;
  batches: Record<string, BatchReceipt>;
  disputes: Record<string, Dispute>;
  migratedAt?: string;
}

export interface Auditor {
  id: string;
  name: string;
  initials: string;
}

export interface EvidenceDraft {
  componentId: string;
  kind: EvidenceKind;
  title: string;
  detail: string;
  contact?: string;
  attachmentName?: string;
  validUntil?: string;
}
