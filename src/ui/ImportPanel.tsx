import { useRef, useState } from 'react';
import { FileUp, Loader2, OctagonAlert, Play, RotateCw, Upload } from 'lucide-react';
import type { LensEngine } from '../core/engine';
import { parseLockfile, SAMPLE_LOCK_V1, SAMPLE_LOCK_V2 } from '../core/lockfile';
import type { Auditor } from '../core/types';

export function ImportPanel({
  engine,
  auditor,
  notify,
}: {
  engine: LensEngine;
  auditor: Auditor;
  notify: (msg: string, tone?: 'ok' | 'error' | 'info') => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [failNext, setFailNext] = useState(0);
  const [interruptAt, setInterruptAt] = useState(0);

  const runScan = async (text: string, label: string) => {
    let deps;
    try {
      deps = parseLockfile(text);
    } catch (err) {
      notify(`${label} 解析失败：${(err as Error).message}`, 'error');
      return;
    }
    if (deps.length === 0) {
      notify('锁文件中没有可导入的依赖', 'error');
      return;
    }
    if (failNext > 0) {
      engine.injectDiskFailures(failNext);
    }
    setBusy(true);
    notify(`开始扫描 ${deps.length} 个依赖（${label}）…`, 'info');
    // 让逐项落盘在 UI 上可见
    await new Promise((r) => setTimeout(r, 60));
    const res = engine.startScan(deps, auditor, interruptAt > 0 ? { interruptAfter: interruptAt } : {});
    setBusy(false);
    if (res.failure) {
      notify(`扫描中断：${res.failure}。完整批次已保留，请到恢复中心继续`, 'error');
    } else if (res.interrupted) {
      const done = res.receipt.items.filter((i) => i.status === 'done').length;
      notify(`扫描被中断：已落盘 ${done}/${res.receipt.items.length}，半截状态已记录`, 'error');
    } else {
      notify(`扫描完成：${res.receipt.items.length} 个依赖已入链（批次 ${res.receipt.id.slice(-8)}）`, 'ok');
    }
  };

  const onFile = async (file: File) => {
    const text = await file.text();
    await runScan(text, file.name);
  };

  return (
    <div className="card import-panel">
      <div className="import-head">
        <FileUp size={16} />
        <div>
          <b>导入锁文件</b>
          <p>逐项落盘生成批次回执；中断或写盘失败后可从完整批次继续</p>
        </div>
      </div>
      <div
        className="dropzone"
        onClick={() => fileRef.current?.click()}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          const f = e.dataTransfer.files?.[0];
          if (f) void onFile(f);
        }}
      >
        <Upload size={20} />
        <span>拖入 package-lock.json 或点击选择</span>
        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void onFile(f);
            e.target.value = '';
          }}
        />
      </div>
      <div className="sample-row">
        <button className="outline" disabled={busy} onClick={() => void runScan(SAMPLE_LOCK_V1, '样例锁文件 v1（2.4.0）')}>
          <Play size={13} /> 样例 v1
        </button>
        <button className="outline" disabled={busy} onClick={() => void runScan(SAMPLE_LOCK_V2, '样例锁文件 v2（升级换证）')}>
          <RotateCw size={13} /> 样例 v2（指纹变化）
        </button>
      </div>
      <div className="fault-controls">
        <label>
          <OctagonAlert size={13} /> 扫描在第
          <input
            type="number"
            min={0}
            max={20}
            value={interruptAt || ''}
            onChange={(e) => setInterruptAt(Math.max(0, Number(e.target.value) || 0))}
            placeholder="N"
          />
          项后中断（0=不中断）
        </label>
        <label>
          <OctagonAlert size={13} /> 注入
          <input
            type="number"
            min={0}
            max={10}
            value={failNext || ''}
            onChange={(e) => setFailNext(Math.max(0, Number(e.target.value) || 0))}
            placeholder="n"
          />
          次落盘失败
        </label>
        {busy && <span className="busy"><Loader2 size={13} className="spin" /> 批次进行中…</span>}
      </div>
    </div>
  );
}
