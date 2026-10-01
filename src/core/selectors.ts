// 审查链视图与覆盖判定：裁决有效性、证据覆盖、建议
import { findRule } from './policy';
import type {
  Component,
  Evidence,
  EvidenceKind,
  StoreState,
  Verdict,
  VerdictKind,
} from './types';

export const COVERING_KINDS: EvidenceKind[] = [
  'commercial-license',
  'exemption',
];

export function evidenceActive(ev: Evidence, now = new Date()): boolean {
  if (!ev.validUntil) return true;
  const end = new Date(ev.validUntil);
  return Number.isFinite(end.getTime()) && end.getTime() >= now.getTime();
}

/** 授权与豁免覆盖对应组件（未过期） */
export function coveringEvidence(
  state: Pick<StoreState, 'evidence'>,
  componentId: string,
  now?: Date,
): Evidence[] {
  return Object.values(state.evidence)
    .filter(
      (e) =>
        e.componentId === componentId &&
        COVERING_KINDS.includes(e.kind) &&
        evidenceActive(e, now),
    )
    .sort((a, b) => (a.addedAt < b.addedAt ? 1 : -1));
}

/** 旧裁决在包指纹或基线更新后失效，等待重新确认；v1 迁移裁决即使匹配也需重认 */
export function verdictStatus(
  state: Pick<StoreState, 'baseline' | 'verdicts'>,
  comp: Component | undefined,
): 'fresh' | 'stale-fingerprint' | 'stale-baseline' | 'stale-legacy' | 'missing' {
  if (!comp) return 'missing';
  const v = state.verdicts[comp.id];
  if (!v) return 'missing';
  if (v.fingerprint !== comp.fingerprint) return 'stale-fingerprint';
  if (v.baselineVersion !== state.baseline.version) return 'stale-baseline';
  if (v.legacy) return 'stale-legacy';
  return 'fresh';
}

export function getVerdict(
  state: Pick<StoreState, 'baseline' | 'verdicts'>,
  componentId: string,
): Verdict | undefined {
  return state.verdicts[componentId];
}

/**
 * 当前建议：
 * 1) 有效商业授权/豁免覆盖 → approved（授权优先）
 * 2) 否则按策略基线判定
 */
export function suggestedDecision(
  state: Pick<StoreState, 'baseline' | 'evidence'>,
  comp: Component,
): { decision: VerdictKind; reason: string } {
  const covers = coveringEvidence(state, comp.id);
  if (covers.length > 0) {
    const top = covers[0];
    return {
      decision: 'approved',
      reason:
        top.kind === 'commercial-license'
          ? `商业授权覆盖：${top.title}`
          : `法务豁免覆盖：${top.title}`,
    };
  }
  const rule = findRule(state.baseline, comp.license);
  return {
    decision: rule?.decision ?? 'review',
    reason: rule ? `${rule.label} · ${rule.note}` : '基线无匹配规则，待复核',
  };
}

export interface ComponentView {
  component: Component;
  verdict?: Verdict;
  validity: ReturnType<typeof verdictStatus>;
  covers: Evidence[];
  support: Evidence[];
  suggestion: { decision: VerdictKind; reason: string };
  pending: boolean; // 是否存在未完成的批次项
}

export function buildViews(
  state: StoreState,
  opts?: { pendingComponentIds?: Set<string> },
): ComponentView[] {
  const pending = opts?.pendingComponentIds ?? new Set<string>();
  return Object.values(state.components)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((component) => {
      const validity = verdictStatus(state, component);
      const all = Object.values(state.evidence).filter(
        (e) => e.componentId === component.id,
      );
      return {
        component,
        verdict: state.verdicts[component.id],
        validity,
        covers: coveringEvidence(state, component.id),
        support: all
          .filter((e) => !COVERING_KINDS.includes(e.kind) && evidenceActive(e))
          .sort((a, b) => (a.addedAt < b.addedAt ? 1 : -1)),
        suggestion: suggestedDecision(state, component),
        pending: pending.has(component.id),
      };
    });
}

export function pendingItems(state: StoreState) {
  const items = [];
  for (const b of Object.values(state.batches)) {
    if (b.status === 'committed' || b.status === 'disputed') continue;
    for (const item of b.items) {
      if (item.status === 'pending' || item.status === 'failed') items.push({ batch: b, item });
    }
  }
  return items;
}

export function openDisputes(state: StoreState) {
  return Object.values(state.disputes)
    .filter((d) => d.status === 'open')
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export function recentBatches(state: StoreState, n = 20) {
  return Object.values(state.batches)
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))
    .slice(0, n);
}

export function isFinished(batch: { status: string }): boolean {
  return batch.status === 'committed' || batch.status === 'disputed';
}
