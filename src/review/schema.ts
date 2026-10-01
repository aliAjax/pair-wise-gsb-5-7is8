// License Lens —— 可恢复审查链的领域模型
// 依赖（指纹）· 许可证证据 · 策略基线 · 批次回执（哈希链）

export type Decision = 'ok' | 'warn' | 'risk';

export interface Verdict {
  decision: Decision;
  note: string;
  by: string;
  at: number;
  basisFp: string;        // 做出裁决时的包指纹
  basisBaseline: string;  // 做出裁决时的策略基线版本
  reconfirmedAt?: number; // 最近一次重新确认
}

export interface Evidence {
  id: string;
  kind: 'lockfile' | 'license' | 'notice' | 'grant-deed' | 'email' | 'manifest';
  title: string;
  ref: string;          // 原文定位 / 链接 / 条款
  hash: string;         // 证据内容指纹
  at: number;
  by: string;
}

export interface Component {
  id: string;
  name: string;
  version: string;
  source: 'npm' | '手动' | 'lockfile';
  declaredLicense: string;
  fingerprint: string;
  verdict?: Verdict;
}

export interface Grant {
  id: string;
  title: string;
  vendor: string;
  componentId: string;   // 覆盖的对应组件
  commercialKey: string; // 商业授权密钥 / 合同号
  ref: string;
  at: number;
  by: string;
  expiresAt?: number;
}

export interface Exemption {
  id: string;
  componentId: string;
  reason: string;
  ticket: string;
  at: number;
  by: string;
  expiresAt?: number;
}

export interface BaselineRule {
  license: string;
  decision: Decision;
  rationale: string;
}

export interface Baseline {
  id: string;
  version: string;
  name: string;
  at: number;
  by: string;
  rules: BaselineRule[];
}

export type ItemState = 'pending' | 'done' | 'failed' | 'skipped';

// 审查材料的原子变更；完整序列化进批次，落盘失败 / 并发争议时材料不丢
export type Change =
  | { t: 'component'; component: Omit<Component, 'verdict'>; evidence?: Omit<Evidence, 'id' | 'at' | 'by'> }
  | { t: 'verdict'; componentId: string; decision: Decision; note: string }
  | { t: 'reconfirm'; componentId: string }
  | { t: 'evidence'; componentId: string; ev: Omit<Evidence, 'id' | 'at' | 'by'> }
  | { t: 'grant'; grant: Omit<Grant, 'id' | 'at' | 'by'>; grantId: string }
  | { t: 'exemption'; ex: Omit<Exemption, 'id' | 'at' | 'by'>; exId: string }
  | { t: 'baseline'; baseline: Omit<Baseline, 'id' | 'at' | 'by'>; baselineId: string };

export interface BatchItem {
  key: string;
  label: string;
  state: ItemState;
  error?: string;
  change: Change;
}

export type BatchState = 'running' | 'interrupted' | 'committed' | 'failed' | 'disputed';

export interface Batch {
  id: string;
  kind: 'import' | 'review' | 'grant' | 'baseline' | 'migration' | 'recovery';
  title: string;
  roundId: string;
  by: string;
  startedAt: number;
  finishedAt?: number;
  state: BatchState;
  baseRev: number;
  commitRev?: number;
  items: BatchItem[];
  materialHash: string; // 完整材料指纹，续跑 / 争议时据此核对材料未被篡改
  parentHash: string;
  hash?: string;        // 回执哈希，与上一批串联
  diskError?: string;
}

export interface Dispute {
  id: string;
  roundId: string;
  batchId: string;       // 后到者的批次（材料被完整保留）
  at: number;
  by: string;            // 后到者
  reason: string;
  baseRev: number;
  winnerRev: number;     // 先到者落盘的修订号
  changes: Change[];
  componentIds: string[];
  status: 'open' | 'resolved';
  resolution?: string;
  resolvedAt?: number;
}

export interface Doc {
  schema: 2;
  rev: number;
  headHash: string;
  baselineId: string;
  baselines: Baseline[];
  components: Component[];
  grants: Grant[];
  exemptions: Exemption[];
  batches: Batch[];
  disputes: Dispute[];
  /** 易失字段：指向 LIVE 中的运行/中断批次 id，仅用于驱动刷新后的 UI 提示 */
  liveRef?: string | null;
}

export interface Toast {
  id: string;
  text: string;
  tone: 'ok' | 'warn' | 'risk' | 'info';
}

// ---------- 确定性哈希（完整性指纹用，非加密用途） ----------
function sorted(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sorted);
  if (v && typeof v === 'object') {
    return Object.keys(v as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = sorted((v as Record<string, unknown>)[k]);
        return acc;
      }, {});
  }
  return v;
}

export function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export const canon = (v: unknown) => JSON.stringify(sorted(v));
export const hashOf = (v: unknown) => fnv1a(canon(v));
export const fpOf = (name: string, version: string, license: string) =>
  fnv1a(`pkg|${name}|${version}|${license}`);
export const short = (h?: string) => (h ? h.slice(0, 8) : '—');

export const slug = (s: string) =>
  'c_' + s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

// ---------- 派生状态 ----------
export interface Effective {
  decision: Decision | 'cleared' | 'exempt';
  stale: boolean;       // 旧裁决等待重新确认
  covered: 'grant' | 'exemption' | null;
  disputed: boolean;
}

export function baselineOf(doc: Doc): Baseline {
  return doc.baselines.find((b) => b.id === doc.baselineId) ?? doc.baselines[0];
}

export function baselineDecision(doc: Doc, license: string): Decision {
  const rule = baselineOf(doc).rules.find((r) => r.license === license);
  return rule?.decision ?? 'warn';
}

export function effective(doc: Doc, c: Component, openDisputes: Dispute[]): Effective {
  const now = Date.now();
  const grant = doc.grants.find((g) => g.componentId === c.id && (!g.expiresAt || g.expiresAt > now));
  const exemption = doc.exemptions.find((x) => x.componentId === c.id && (!x.expiresAt || x.expiresAt > now));
  const disputed = openDisputes.some((d) => d.componentIds.includes(c.id));
  let stale = false;
  if (c.verdict) {
    stale = c.verdict.basisFp !== c.fingerprint || c.verdict.basisBaseline !== baselineOf(doc).version;
  }
  return {
    decision: exemption ? 'exempt' : grant ? 'cleared' : c.verdict?.decision ?? baselineDecision(doc, c.declaredLicense),
    stale,
    covered: exemption ? 'exemption' : grant ? 'grant' : null,
    disputed,
  };
}

export function changeComponentId(c: Change): string | null {
  switch (c.t) {
    case 'component': return c.component.id;
    case 'verdict':
    case 'reconfirm':
    case 'evidence':
      return c.componentId;
    case 'grant': return c.grant.componentId;
    case 'exemption': return c.ex.componentId;
    case 'baseline': return null;
  }
}
