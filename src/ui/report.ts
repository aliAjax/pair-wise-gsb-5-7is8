import type { StoreState } from '../core/types';
import { buildViews } from '../core/selectors';
import { decisionLabel, evidenceKindLabel } from './format';

/** 导出审查链 Markdown 报告（含指纹、基线版本、裁决有效性、证据与争议） */
export function exportReport(state: StoreState): void {
  const views = buildViews(state).sort((a, b) => {
    const rank = { rejected: 0, review: 1, approved: 2 };
    return rank[a.suggestion.decision] - rank[b.suggestion.decision];
  });
  const validityLabel: Record<string, string> = {
    fresh: '有效',
    'stale-fingerprint': '指纹已变·待确认',
    'stale-baseline': '基线已更新·待确认',
    'stale-legacy': '旧数据·待确认',
    missing: '未裁决',
  };
  const openDisputes = Object.values(state.disputes).filter((d) => d.status === 'open');

  const lines: string[] = [];
  lines.push('# License Lens 收购尽调审查报告');
  lines.push('');
  lines.push(`- 策略基线：v${state.baseline.version}（${state.baseline.publishedBy} 发布）`);
  lines.push(`- 组件总数：${views.length}`);
  lines.push(`- 有效裁决：${views.filter((v) => v.validity === 'fresh').length}`);
  lines.push(`- 待重新确认：${views.filter((v) => v.validity !== 'fresh').length}`);
  lines.push(`- 未决争议：${openDisputes.length}`);
  if (state.migratedAt) lines.push(`- 旧数据迁移时间：${state.migratedAt}`);
  lines.push('');
  lines.push('| 组件 | 版本 | 许可证 | 指纹 | 基线 | 裁决 | 有效性 | 覆盖材料 | 建议 |');
  lines.push('|---|---|---|---|---|---|---|---|---|');
  for (const v of views) {
    const c = v.component;
    lines.push(
      `| ${c.name} | ${c.version} | ${c.license} | \`${c.fingerprint.slice(0, 13)}…\` | v${v.verdict?.baselineVersion ?? '—'} | ${
        v.verdict ? decisionLabel[v.verdict.decision] : '—'
      } | ${validityLabel[v.validity]} | ${v.covers.map((e) => evidenceKindLabel[e.kind]).join('、') || '—'} | ${decisionLabel[v.suggestion.decision]} |`,
    );
  }
  if (openDisputes.length > 0) {
    lines.push('', '## 未决争议', '');
    for (const d of openDisputes) {
      lines.push(`- **${d.laterLabel}**：先到 ${d.earlierBy} / 后到 ${d.laterBy}，组件 ${d.componentIds.join('、')}，后到材料 ${d.laterItems.length} 份待合并`);
    }
  }
  lines.push('', '## 批次回执', '');
  for (const b of Object.values(state.batches).sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))) {
    const counts: Record<string, number> = {};
    for (const i of b.items) counts[i.status] = (counts[i.status] ?? 0) + 1;
    lines.push(
      `- \`${b.id}\` ${b.label} · ${b.status} · ${b.startedBy} · ${Object.entries(counts)
        .map(([k, n]) => `${k}×${n}`)
        .join(' ')}`,
    );
  }

  const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `license-lens-review-${new Date().toISOString().slice(0, 10)}.md`;
  a.click();
  URL.revokeObjectURL(a.href);
}
