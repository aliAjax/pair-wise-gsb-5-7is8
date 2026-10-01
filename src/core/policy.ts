import type { Baseline, BaselineRule, VerdictKind } from './types';

// 策略基线 v1：尽调开始时的默认裁决规则
export const DEFAULT_RULES: BaselineRule[] = [
  { license: 'MIT', decision: 'approved', label: '宽松许可', note: '可商用，保留版权声明即可' },
  { license: 'BSD-3-Clause', decision: 'review', label: '保留声明', note: '再发布需保留版权与三条款声明' },
  { license: 'BSD-2-Clause', decision: 'review', label: '保留声明', note: '再发布需保留版权声明' },
  { license: 'Apache-2.0', decision: 'approved', label: '专利授权', note: '含明确专利授权，注意 NOTICE 文件' },
  { license: 'ISC', decision: 'approved', label: '宽松许可', note: '可商用，保留声明即可' },
  { license: 'MPL-2.0', decision: 'review', label: '弱著佐权', note: '修改文件需开源，可与闭源代码共存' },
  { license: 'LGPL-2.1', decision: 'review', label: '弱著佐权', note: '动态链接可闭源，静态链接需提供可重链接物' },
  { license: 'GPL-2.0', decision: 'rejected', label: '强著佐权', note: '与闭源分发冲突，需法务介入' },
  { license: 'GPL-3.0', decision: 'rejected', label: '强著佐权', note: '与闭源分发冲突，需替换或取得商业授权' },
  { license: 'AGPL-3.0', decision: 'rejected', label: '网络著佐权', note: 'SaaS 场景也触发开源义务' },
  { license: 'SSPL-1.0', decision: 'rejected', label: '源码可用但非开源', note: '托管服务触发全部开源义务' },
  { license: 'BUSL-1.1', decision: 'review', label: '延迟开源', note: '注意变更日期与使用限制' },
  { license: 'UNKNOWN', decision: 'review', label: '许可证缺失', note: '元数据未声明许可证，必须人工核实' },
];

export function defaultBaseline(now: string): Baseline {
  return {
    version: 1,
    publishedAt: now,
    publishedBy: 'system',
    rules: DEFAULT_RULES,
  };
}

export function findRule(
  baseline: Baseline,
  license: string,
): BaselineRule | undefined {
  const exact = baseline.rules.find(
    (r) => r.license.toLowerCase() === license.trim().toLowerCase(),
  );
  if (exact) return exact;
  // 兼容 SPDX 表达式的简单前缀匹配（如 (MIT OR Apache-2.0)）
  return baseline.rules.find((r) =>
    license.toUpperCase().includes(r.license.toUpperCase()),
  );
}

export function policyDecision(baseline: Baseline, license: string): VerdictKind {
  return findRule(baseline, license)?.decision ?? 'review';
}

export function policyNote(baseline: Baseline, license: string): string {
  return findRule(baseline, license)?.note ?? '基线无匹配规则，按待复核处理';
}
