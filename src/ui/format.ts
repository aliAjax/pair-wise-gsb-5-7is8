import type { BatchStatus, VerdictKind } from '../core/types';

export function shortTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function dateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getMonth() + 1}/${d.getDate()} ${shortTime(iso)}`;
}

export const decisionLabel: Record<VerdictKind, string> = {
  approved: '通过',
  review: '待复核',
  rejected: '拒绝',
};

export const batchStatusLabel: Record<BatchStatus, string> = {
  running: '进行中',
  partial: '已中断',
  committed: '已提交',
  failed: '落盘失败',
  disputed: '争议中',
};

export const evidenceKindLabel: Record<string, string> = {
  'commercial-license': '商业授权',
  exemption: '法务豁免',
  'license-text': '许可证原文',
  'purchase-receipt': '采购凭证',
};
