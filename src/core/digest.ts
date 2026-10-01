// 内容指纹：FNV-1a 64-bit，纯同步实现，浏览器/Node 均可运行

export function fnv1a64(input: string): string {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < input.length; i++) {
    h ^= BigInt(input.charCodeAt(i));
    h = BigInt.asUintN(64, h * 0x100000001b3n);
  }
  return h.toString(16).padStart(16, '0');
}

export function componentId(ecosystem: string, name: string): string {
  return `${ecosystem}:${name.toLowerCase()}`;
}

/** 组件指纹随 名称/版本/声明许可证/生态 任一变化而变化 */
export function fingerprintOf(c: {
  name: string;
  version: string;
  license: string;
  ecosystem: string;
}): string {
  const canonical = [
    c.ecosystem.toLowerCase(),
    c.name.toLowerCase().trim(),
    c.version.trim(),
    c.license.trim(),
  ].join('|');
  return `f1:${fnv1a64(canonical)}`;
}

export function evidenceId(
  componentId: string,
  kind: string,
  title: string,
): string {
  return `ev:${componentId}:${kind}:${fnv1a64(title.trim().toLowerCase())}`;
}

export function batchId(now: number, nonce: string): string {
  return `batch:${now.toString(36)}-${fnv1a64(nonce).slice(0, 8)}`;
}
