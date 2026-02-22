import { createHash } from "crypto";

export interface ContextCacheEntry {
  key: string;
  root: string;
  value: string;
  createdAt: number;
  expiresAt: number;
  lastUsedAt: number;
}

export interface ContextCacheRequest {
  key: string;
  root: string;
}

export interface ContextCacheOptions {
  ttlMs?: number;
  maxEntries?: number;
}

export class ContextCache {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly entries = new Map<string, ContextCacheEntry>();
  private readonly pending = new Map<string, Promise<string>>();

  constructor(options?: ContextCacheOptions) {
    this.ttlMs = options?.ttlMs ?? 30_000;
    this.maxEntries = options?.maxEntries ?? 32;
  }

  private makeRequestHash(request: ContextCacheRequest): string {
    const payload = `${request.root}\u0000${request.key}`;
    return createHash("sha1").update(payload).digest("hex");
  }

  async getOrLoad(request: ContextCacheRequest, loader: () => Promise<string>): Promise<string> {
    const now = Date.now();
    const cacheKey = this.makeRequestHash(request);

    const cached = this.entries.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      cached.lastUsedAt = now;
      this.entries.delete(cacheKey);
      this.entries.set(cacheKey, cached);
      return cached.value;
    }

    const inFlight = this.pending.get(cacheKey);
    if (inFlight) {
      return inFlight;
    }

    const promise = (async () => {
      const value = await loader();

      const entry: ContextCacheEntry = {
        key: request.key,
        root: request.root,
        value,
        createdAt: now,
        expiresAt: now + this.ttlMs,
        lastUsedAt: now,
      };

      this.entries.delete(cacheKey);
      this.entries.set(cacheKey, entry);

      if (this.entries.size > this.maxEntries) {
        const firstKey = this.entries.keys().next().value;
        if (firstKey !== undefined) {
          this.entries.delete(firstKey);
        }
      }

      return value;
    })();

    this.pending.set(cacheKey, promise);
    try {
      return await promise;
    } finally {
      this.pending.delete(cacheKey);
    }
  }

  invalidateRoot(root: string): void {
    for (const [cacheKey, entry] of this.entries) {
      if (entry.root === root) {
        this.entries.delete(cacheKey);
      }
    }
  }

  clear(): void {
    this.entries.clear();
    this.pending.clear();
  }
}
