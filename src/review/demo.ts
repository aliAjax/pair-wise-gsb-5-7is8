import type { Change, Decision } from './schema';
import { fpOf, hashOf, slug } from './schema';

export interface LockPkg {
  name: string;
  version: string;
  license: string;
}

// 模拟锁文件：含新版本（触发指纹更新 → 旧裁决等待重新确认）与全新依赖
export const LOCKFILE: LockPkg[] = [
  { name: 'react', version: '19.1.0', license: 'MIT' },           // 指纹变化
  { name: 'lodash', version: '4.17.21', license: 'MIT' },          // 不变
  { name: 'chart.js', version: '4.4.4', license: 'MIT' },
  { name: 'highlight.js', version: '11.10.0', license: 'BSD-3-Clause' },
  { name: 'legacy-parser', version: '2.1.0', license: 'GPL-3.0' },
  { name: 'dayjs', version: '1.11.13', license: 'MIT' },           // 新增
  { name: 'pdf-kit-pro', version: '5.2.0', license: '商业许可' },   // 新增，待商业授权覆盖
  { name: 'old-crypto', version: '0.4.2', license: 'GPL-2.0' },    // 新增风险
];

export const LOCK_REF = 'aurora-web@9ae2-lock';

export function lockfileChanges(): Change[] {
  return LOCKFILE.map((p) => ({
    t: 'component',
    component: {
      id: slug(p.name),
      name: p.name,
      version: p.version,
      source: 'lockfile' as const,
      declaredLicense: p.license,
      fingerprint: fpOf(p.name, p.version, p.license),
    },
    evidence: {
      kind: 'lockfile' as const,
      title: `package-lock.json · ${p.name}@${p.version}`,
      ref: LOCK_REF,
      hash: hashOf(['lock', LOCK_REF, p.name, p.version, p.license]),
    },
  }));
}

export function verdictChange(componentId: string, decision: Decision, note: string): Change {
  return { t: 'verdict', componentId, decision, note };
}

export function reconfirmChange(componentId: string): Change {
  return { t: 'reconfirm', componentId };
}

export function evidenceChange(componentId: string, kind: 'license' | 'notice', title: string, ref: string): Change {
  return {
    t: 'evidence',
    componentId,
    ev: { kind, title, ref, hash: hashOf(['ev', kind, title, ref]) },
  };
}

export function grantChange(opts: {
  componentId: string; title: string; vendor: string; key: string; ref: string; days?: number;
}): Change {
  return {
    t: 'grant',
    grantId: 'g_' + hashOf(['grant', opts.componentId, opts.key]).slice(0, 12),
    grant: {
      title: opts.title,
      vendor: opts.vendor,
      componentId: opts.componentId,
      commercialKey: opts.key,
      ref: opts.ref,
      expiresAt: opts.days ? Date.now() + opts.days * 86400e3 : undefined,
    },
  };
}

export function exemptionChange(componentId: string, reason: string, ticket: string, days = 365): Change {
  return {
    t: 'exemption',
    exId: 'x_' + hashOf(['ex', componentId, ticket]).slice(0, 12),
    ex: {
      componentId, reason, ticket,
      expiresAt: Date.now() + days * 86400e3,
    },
  };
}
