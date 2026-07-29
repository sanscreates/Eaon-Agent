// Lightweight TTL cache — avoids re-running identical tool calls within a session.

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const DEFAULT_TTL = 30_000; // 30 s default TTL

/** Simple LRU-ish TTL cache. Not eviction-aware — entries live until expiry. */
class TTLCache<T> {
  private map = new Map<string, CacheEntry<T>>();
  constructor(private ttl: number) {}
  get(key: string): T | undefined {
    const e = this.map.get(key);
    if (!e || Date.now() > e.expiresAt) { this.map.delete(key); return undefined; }
    return e.value;
  }
  set(key: string, value: T): void {
    this.map.set(key, { value, expiresAt: Date.now() + this.ttl });
  }
  clear(): void { this.map.clear(); }
}

export const toolResultCache = new TTLCache<string>(DEFAULT_TTL);
export const modelListCache = new TTLCache<string[]>(60_000); // 60 s for model lists