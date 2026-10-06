import { browser } from '$app/environment';

export const STORAGE_KEY_V1 = 'medical-safety-signals-v1';
export const STORAGE_KEY_DB = 'medical-safety-db-v2';
export const STORAGE_KEY_V1_BACKUP = 'medical-safety-signals-v1-backup';

export interface PersistFault {
  /** 下一次 persistDb 调用抛出写入异常，随后自动复位（模拟本地写入失败） */
  failNextPersist: boolean;
  reason: string;
}

export const persistFault: PersistFault = {
  failNextPersist: false,
  reason: '本地存储写入失败（演示）'
};

export function readRaw(key: string): unknown {
  if (!browser) return null;
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * 原子写入：先序列化（失败即抛，localStorage 不动），再一次性 setItem。
 * 调用方必须先在内存中构造好完整新状态，确认无误后才调用——
 * 这样持久化失败不会留下“半套案例”。
 */
export function persistDb(db: unknown): void {
  if (!browser) return;
  const serialized = JSON.stringify(db);
  if (persistFault.failNextPersist) {
    persistFault.failNextPersist = false;
    throw new Error(persistFault.reason);
  }
  localStorage.setItem(STORAGE_KEY_DB, serialized);
}

export function writeRaw(key: string, value: unknown): void {
  if (!browser) return;
  localStorage.setItem(key, JSON.stringify(value));
}

export function removeKey(key: string): void {
  if (!browser) return;
  localStorage.removeItem(key);
}
