// ─── Cache en memoria compartida ─────────────────────────────────────────────
// Implementación simple con TTL por entrada.
// Usada tanto por el cliente PRTG como por el servicio de dashboards.

interface CacheEntry {
  data:      unknown;
  timestamp: number;
}

const store = new Map<string, CacheEntry>();

export function getCached<T>(key: string, ttlMs: number): T | null {
  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > ttlMs) {
    store.delete(key);
    return null;
  }
  return entry.data as T;
}

export function setCache(key: string, data: unknown): void {
  store.set(key, { data, timestamp: Date.now() });
}

export function invalidateCache(key: string): void {
  store.delete(key);
}
