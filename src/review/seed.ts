import type { Baseline, Batch, Component, Decision, Doc, Evidence, Exemption, Grant } from './schema';
import { fnv1a, fpOf, hashOf } from './schema';

const T0 = 1758600000000;

export const baselineA: Baseline = {
  id: 'bl_base_v1',
  version: 'BL-2025.1',
  name: '收购尽调基线 v1',
  at: T0,
  by: '合规组',
  rules: [
    { license: 'MIT', decision: 'ok', rationale: '宽松许可，保留版权声明即可商用' },
    { license: 'BSD-3-Clause', decision: 'warn', rationale: '再发布需保留版权与三条款声明' },
    { license: 'Apache-2.0', decision: 'warn', rationale: '需保留 NOTICE 与专利授权条款' },
    { license: 'GPL-3.0', decision: 'risk', rationale: '强 copyleft，与闭源分发冲突，必须替换或取得商业授权' },
  ],
};

export function seedComponents(baselineVersion: string): Component[] {
  const mk = (
    id: string, name: string, version: string, declaredLicense: string,
    source: Component['source'], at: number, by: string,
    decision?: Decision, note = '',
  ): Component => ({
    id, name, version, source, declaredLicense,
    fingerprint: fpOf(name, version, declaredLicense),
    verdict: decision
      ? { decision, note, by, at, basisFp: fpOf(name, version, declaredLicense), basisBaseline: baselineVersion }
      : undefined,
  });
  return [
    mk('c_react', 'react', '18.3.1', 'MIT', 'npm', T0 + 3600e3, '甲（审计员）', 'ok', '宽松许可，可商用'),
    mk('c_lodash', 'lodash', '4.17.21', 'MIT', 'npm', T0 + 3600e3, '甲（审计员）', 'ok', '宽松许可，可商用'),
    mk('c_chart-js', 'chart.js', '4.4.4', 'MIT', 'lockfile', T0 + 7200e3, '扫描器', 'ok', '宽松许可，可商用'),
    mk('c_highlight-js', 'highlight.js', '11.10.0', 'BSD-3-Clause', 'npm', T0 + 7200e3, '乙（审计员）', 'warn', '再发布需保留版权声明'),
    mk('c_legacy-parser', 'legacy-parser', '2.1.0', 'GPL-3.0', '手动', T0 + 10800e3, '乙（审计员）', 'risk', '可能与闭源分发冲突'),
  ];
}

export function seedEvidence(): Evidence[] {
  const t = (id: string, componentName: string, kind: Evidence['kind'], title: string, ref: string): Evidence => ({
    id, kind, title, ref,
    hash: fnv1a(`${id}|${componentName}|${ref}`),
    at: T0 + 7200e3,
    by: '扫描器',
  });
  return [
    t('ev_lock_main', 'aurora-web', 'lockfile', 'package-lock.json', 'aurora-web@7f3c…@lock'),
    t('ev_react_mit', 'react', 'license', 'react/LICENSE (MIT)', 'facebook/react v18.3.1'),
    t('ev_lodash_mit', 'lodash', 'license', 'lodash/LICENSE (MIT)', 'lodash/lodash 4.17.21'),
    t('ev_chart_mit', 'chart.js', 'license', 'chart.js/LICENSE.md (MIT)', 'chartjs/Chart.js v4.4.4'),
    t('ev_hlj_bsd', 'highlight.js', 'license', 'highlight.js/LICENSE (BSD-3)', 'highlightjs/highlight.js 11.10.0'),
    t('ev_legacy_gpl', 'legacy-parser', 'license', 'legacy-parser/COPYING (GPL-3.0)', 'vendored/legacy-parser 2.1.0'),
  ];
}

// 证据与组件的关联记录在批次材料里（component 变更携带 evidence）。
// 为让初始证据可在证据页直接关联展示，单独维护一张来源映射。
export const seedEvidenceLinks: Record<string, string> = {
  ev_react_mit: 'c_react',
  ev_lodash_mit: 'c_lodash',
  ev_chart_mit: 'c_chart-js',
  ev_hlj_bsd: 'c_highlight-js',
  ev_legacy_gpl: 'c_legacy-parser',
};

export function seedGrants(): Grant[] {
  return [];
}
export function seedExemptions(): Exemption[] {
  return [];
}

export function seedDoc(): Doc {
  const components = seedComponents(baselineA.version);
  const genesis: Batch = {
    id: 'b_genesis',
    kind: 'import',
    title: '初始锁文件导入 · aurora-web',
    roundId: 'round-genesis',
    by: '扫描器',
    startedAt: T0,
    finishedAt: T0 + 9000,
    state: 'committed',
    baseRev: 0,
    commitRev: 1,
    items: [],
    materialHash: fnv1a('genesis-material'),
    parentHash: '0'.repeat(8),
    hash: '',
  };
  genesis.hash = hashOf({
    rev: 1,
    parentHash: genesis.parentHash,
    materialHash: genesis.materialHash,
    baseRev: 0,
  });

  return {
    schema: 2,
    rev: 1,
    headHash: genesis.hash,
    baselineId: baselineA.id,
    baselines: [baselineA],
    components,
    grants: seedGrants(),
    exemptions: seedExemptions(),
    batches: [genesis],
    disputes: [],
  };
}

// 旧格式（v1）数据 —— 模拟升级前用户本地 localStorage 里的快照
export const legacyV1 = () =>
  JSON.stringify([
    { id: 1, name: 'react', version: '18.3.1', license: 'MIT', source: 'npm', status: 'ok', note: '宽松许可，可商用' },
    { id: 2, name: 'lodash', version: '4.17.21', license: 'MIT', source: 'npm', status: 'ok', note: '宽松许可，可商用' },
    { id: 3, name: 'chart.js', version: '4.4.4', license: 'MIT', source: 'npm', status: 'ok', note: '宽松许可，可商用' },
    { id: 4, name: 'highlight.js', version: '11.10.0', license: 'BSD-3-Clause', source: 'npm', status: 'warn', note: '再发布需保留版权声明' },
    { id: 5, name: 'legacy-parser', version: '2.1.0', license: 'GPL-3.0', source: '手动', status: 'risk', note: '可能与闭源分发冲突' },
  ]);
