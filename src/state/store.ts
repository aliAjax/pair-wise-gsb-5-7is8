import { useSyncExternalStore } from 'react';
import { LensEngine } from '../core/engine';
import { LocalStoragePersistence } from '../core/persistence';
import type { Auditor, StoreState } from '../core/types';

export const AUDITORS: Auditor[] = [
  { id: 'auditor-jia', name: '审计员甲（依赖裁决）', initials: '甲' },
  { id: 'auditor-yi', name: '审计员乙（商业授权）', initials: '乙' },
];

let engineSingleton: LensEngine | null = null;

export function getEngine(): LensEngine {
  if (engineSingleton) return engineSingleton;
  const adapter = new LocalStoragePersistence();
  engineSingleton = new LensEngine(adapter);
  return engineSingleton;
}

/** 订阅引擎状态；跨标签 storage 事件也会触发更新 */
export function useEngineState(engine: LensEngine): StoreState {
  return useSyncExternalStore(
    (cb) => engine.subscribe(cb),
    () => engine.state,
    () => engine.state,
  );
}
