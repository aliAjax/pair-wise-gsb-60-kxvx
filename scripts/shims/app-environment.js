// Node 验证脚本用：模拟浏览器环境并提供内存版 localStorage
class MemoryStorage {
  constructor() {
    this.map = new Map();
  }
  getItem(key) {
    return this.map.has(key) ? this.map.get(key) : null;
  }
  setItem(key, value) {
    this.map.set(key, String(value));
  }
  removeItem(key) {
    this.map.delete(key);
  }
  clear() {
    this.map.clear();
  }
}

globalThis.localStorage = globalThis.localStorage ?? new MemoryStorage();

export const browser = true;
export const dev = false;
export const building = false;
export const version = '';
