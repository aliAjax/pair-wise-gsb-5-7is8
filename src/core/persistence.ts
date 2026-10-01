// 持久化适配器：localStorage（带 CAS 修订号、跨标签 storage 事件）与内存实现（测试用）
import type { StoreState } from './types';

export interface CommitConflict {
  ok: false;
  current: StoreState | null;
}
export interface CommitOk {
  ok: true;
  state: StoreState;
}
export type CommitResult = CommitOk | CommitConflict;

export interface PersistenceAdapter {
  /** 启动时读取 */
  load(): StoreState | null;
  /** 读取当前权威状态（其他标签可能已提交） */
  read(): StoreState | null;
  /** CAS：仅当当前 rev === expectedRev 时写入 */
  commit(next: StoreState, expectedRev: number): CommitResult;
  /** 跨标签提交通知 */
subscribe(cb: (remote: StoreState) => void): () => void;
  /** 读取 v1 旧数据（迁移用） */
  loadLegacy?(): unknown;
  /** 清理 v1 旧数据键 */
  clearLegacy?(): void;
  /** 接下来 n 次写入失败（落盘故障注入） */
  setFailNext(n: number): void;
  readonly kind: string;
}

const V2_KEY = 'license-lens-v2';
const LEGACY_KEY = 'license-lens';

export class LocalStoragePersistence implements PersistenceAdapter {
  readonly kind = 'localStorage';
  private failRemaining = 0;
  private listeners = new Set<(remote: StoreState) => void>();

  constructor(private storage: Storage = localStorage) {
    window.addEventListener('storage', this.onStorage);
  }

  private onStorage = (e: StorageEvent) => {
    if (e.key !== V2_KEY || !e.newValue) return;
    try {
      const remote = JSON.parse(e.newValue) as StoreState;
      this.listeners.forEach((cb) => cb(remote));
    } catch {
      /* 忽略无法解析的外部写入 */
    }
  };

  setFailNext(n: number) {
    this.failRemaining = n;
  }

  loadLegacy(): unknown {
    try {
      const raw = this.storage.getItem(LEGACY_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  clearLegacy() {
    this.storage.removeItem(LEGACY_KEY);
  }

  private parseRaw(): StoreState | null {
    const raw = this.storage.getItem(V2_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as StoreState;
  }

  load(): StoreState | null {
    try {
      return this.parseRaw();
    } catch {
      return null;
    }
  }

  read(): StoreState | null {
    try {
      return this.parseRaw();
    } catch {
      return null;
    }
  }

  commit(next: StoreState, expectedRev: number): CommitResult {
    let current: StoreState | null = null;
    try {
      current = this.parseRaw();
    } catch {
      current = null;
    }
    const currentRev = current ? current.rev : 0;
    if (currentRev !== expectedRev) {
      return { ok: false, current };
    }
    if (this.failRemaining > 0) {
      this.failRemaining -= 1;
      throw new Error(
        `磁盘写入失败（故障注入，剩余 ${this.failRemaining} 次）`,
      );
    }
    this.storage.setItem(V2_KEY, JSON.stringify(next));
    return { ok: true, state: next };
  }

  subscribe(cb: (remote: StoreState) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
}

/** 测试用内存适配器：同样实现 CAS 与故障注入 */
export class MemoryPersistence implements PersistenceAdapter {
  readonly kind = 'memory';
  private failRemaining = 0;
  private listeners = new Set<(remote: StoreState) => void>();
  legacy: unknown = null;

  constructor(private data: StoreState | null = null) {}

  setFailNext(n: number) {
    this.failRemaining = n;
  }
  loadLegacy() {
    return this.legacy;
  }
  clearLegacy() {
    this.legacy = null;
  }
  load() {
    return this.data ? (JSON.parse(JSON.stringify(this.data)) as StoreState) : null;
  }
  read() {
    return this.load();
  }
  commit(next: StoreState, expectedRev: number): CommitResult {
    const current = this.data;
    if ((current ? current.rev : 0) !== expectedRev) {
      return { ok: false, current: current ? this.load() : null };
    }
    if (this.failRemaining > 0) {
      this.failRemaining -= 1;
      throw new Error(
        `磁盘写入失败（故障注入，剩余 ${this.failRemaining} 次）`,
      );
    }
    this.data = JSON.parse(JSON.stringify(next)) as StoreState;
    const snapshot = this.load()!;
    this.listeners.forEach((cb) => cb(snapshot));
    return { ok: true, state: snapshot };
  }
  subscribe(cb: (remote: StoreState) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  /** 测试辅助：模拟另一个标签直接提交（修订号 +1） */
  externalCommit(mutate: (s: StoreState) => StoreState) {
    if (!this.data) throw new Error('no state');
    const draft = JSON.parse(JSON.stringify(this.data)) as StoreState;
    const next = mutate(draft);
    next.rev = this.data.rev + 1;
    this.data = JSON.parse(JSON.stringify(next)) as StoreState;
    this.listeners.forEach((cb) => cb(this.load()!));
  }
}
