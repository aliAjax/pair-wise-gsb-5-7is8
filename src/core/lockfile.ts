// 锁文件解析：支持 npm package-lock v3/v2，提取依赖名/版本/许可证
import { fingerprintOf } from './digest';

export interface ParsedDep {
  name: string;
  version: string;
  ecosystem: string;
  license: string;
  fingerprint: string;
}

function normalizeLicense(raw: unknown): string {
  if (!raw) return 'UNKNOWN';
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) return raw.map(normalizeLicense).join(' OR ') || 'UNKNOWN';
  if (typeof raw === 'object' && raw !== null && 'type' in raw) {
    const t = (raw as { type?: unknown }).type;
    return typeof t === 'string' ? t : 'UNKNOWN';
  }
  return 'UNKNOWN';
}

export function parseNpmLock(text: string): ParsedDep[] {
  const data = JSON.parse(text) as {
    packages?: Record<string, { version?: string; license?: unknown; resolved?: string }>;
    dependencies?: Record<string, { version?: string; license?: unknown }>;
  };
  const map = new Map<string, ParsedDep>();
  const push = (name: string, version: string | undefined, rawLicense: unknown) => {
    if (!version) return;
    const license = normalizeLicense(rawLicense);
    const ecosystem = 'npm';
    map.set(`${ecosystem}:${name.toLowerCase()}`, {
      name,
      version,
      ecosystem,
      license,
      fingerprint: fingerprintOf({ name, version, license, ecosystem }),
    });
  };

  if (data.packages) {
    for (const [pkgPath, meta] of Object.entries(data.packages)) {
      if (!pkgPath.startsWith('node_modules/')) continue;
      // 嵌套路径取最后一段 node_modules/<name>
      const segs = pkgPath.split('node_modules/');
      const name = segs[segs.length - 1];
      if (!name) continue;
      push(name, meta.version, meta.license);
    }
  }
  if (data.dependencies) {
    for (const [name, meta] of Object.entries(data.dependencies)) {
      push(name, meta.version, meta.license);
    }
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function parseLockfile(text: string): ParsedDep[] {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) return parseNpmLock(trimmed);
  throw new Error('仅支持 npm package-lock.json 格式的锁文件');
}

// ---- 演示用锁文件样例（收购目标 Aurora-Web 的依赖清单）----

export const SAMPLE_LOCK_V1 = JSON.stringify(
  {
    name: 'aurora-web',
    version: '2.4.0',
    lockfileVersion: 3,
    packages: {
      '': { name: 'aurora-web', version: '2.4.0', license: 'UNLICENSED' },
      'node_modules/react': { version: '18.3.1', license: 'MIT' },
      'node_modules/lodash': { version: '4.17.21', license: 'MIT' },
      'node_modules/chart.js': { version: '4.4.4', license: 'MIT' },
      'node_modules/highlight.js': { version: '11.10.0', license: 'BSD-3-Clause' },
      'node_modules/legacy-parser': { version: '2.1.0', license: 'GPL-3.0' },
    },
  },
  null,
  2,
);

// 版本升级后的锁文件：react 大版本变更、legacy-parser 换证、新增 sspldb
export const SAMPLE_LOCK_V2 = JSON.stringify(
  {
    name: 'aurora-web',
    version: '2.5.0',
    lockfileVersion: 3,
    packages: {
      '': { name: 'aurora-web', version: '2.5.0', license: 'UNLICENSED' },
      'node_modules/react': { version: '19.0.0', license: 'MIT' },
      'node_modules/lodash': { version: '4.17.21', license: 'MIT' },
      'node_modules/chart.js': { version: '4.4.4', license: 'MIT' },
      'node_modules/highlight.js': { version: '11.10.0', license: 'BSD-3-Clause' },
      'node_modules/legacy-parser': { version: '2.2.0', license: 'Apache-2.0' },
      'node_modules/sspldb': { version: '1.3.0', license: 'SSPL-1.0' },
    },
  },
  null,
  2,
);
