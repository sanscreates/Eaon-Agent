// Lightweight TTL cache — avoids re-running identical tool calls within a session.

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const DEFAULT_TTL = 30_000; // 30 s default TTL
const MAX_ENTRIES = 256;

/** TTL cache with an insertion-order bound, so a long session holding on to
 *  large tool results cannot grow without limit. */
class TTLCache<T> {
  private map = new Map<string, CacheEntry<T>>();
  constructor(private ttl: number) {}
  get(key: string): T | undefined {
    const e = this.map.get(key);
    if (!e || Date.now() > e.expiresAt) { this.map.delete(key); return undefined; }
    return e.value;
  }
  set(key: string, value: T): void {
    this.map.delete(key); // re-insert so the eviction order is recency
    this.map.set(key, { value, expiresAt: Date.now() + this.ttl });
    while (this.map.size > MAX_ENTRIES) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.map.delete(oldest.value);
    }
  }
  clear(): void { this.map.clear(); }
}

export const toolResultCache = new TTLCache<string>(DEFAULT_TTL);