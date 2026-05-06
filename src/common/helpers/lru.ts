export type LruCacheOptions<TKey extends string | number> = {
  shouldCache?: (key: TKey) => boolean;
  keyToString?: (key: TKey) => string;
};

export class LruCache<TKey extends string | number, TValue> {
  private readonly items = new Map<string, TValue>();
  private readonly shouldCache: (key: TKey) => boolean;
  private readonly keyToString: (key: TKey) => string;

  constructor(
    private readonly capacity: number,
    options: LruCacheOptions<TKey> = {},
  ) {
    this.shouldCache = options.shouldCache ?? (() => true);
    this.keyToString = options.keyToString ?? ((key) => String(key));
  }

  public async getOrFetch(key: TKey, fetcher: () => Promise<TValue>): Promise<TValue> {
    if (!this.shouldCache(key)) {
      return await fetcher();
    }

    const cacheKey = this.keyToString(key);
    if (this.items.has(cacheKey)) {
      const cached = this.items.get(cacheKey) as TValue;
      this.items.delete(cacheKey);
      this.items.set(cacheKey, cached);
      return cached;
    }

    const value = await fetcher();
    this.items.set(cacheKey, value);
    if (this.items.size > this.capacity) {
      const oldestKey = this.items.keys().next().value;
      if (oldestKey !== undefined) {
        this.items.delete(oldestKey);
      }
    }
    return value;
  }

  public clear(): void {
    this.items.clear();
  }
}
