export type LruCacheOptions<TKey extends string | number, TValue> = {
  shouldCache?: (key: TKey) => boolean;
  // If returns false — value is returned to caller but not stored (e.g. skip `{finalized: false}`).
  shouldCacheValue?: (value: TValue) => boolean;
  keyToString?: (key: TKey) => string;
};

export class LruCache<TKey extends string | number, TValue> {
  private readonly items = new Map<string, TValue>();
  private readonly inFlight = new Map<string, Promise<TValue>>();
  private generation = 0;
  private readonly shouldCache: (key: TKey) => boolean;
  private readonly shouldCacheValue: (value: TValue) => boolean;
  private readonly keyToString: (key: TKey) => string;

  constructor(
    private readonly capacity: number,
    options: LruCacheOptions<TKey, TValue> = {},
  ) {
    this.shouldCache = options.shouldCache ?? (() => true);
    this.shouldCacheValue = options.shouldCacheValue ?? (() => true);
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

    const inFlight = this.inFlight.get(cacheKey);
    if (inFlight) return await inFlight;

    const generation = this.generation;
    const promise: Promise<TValue> = (async () => {
      const value = await fetcher();
      if (generation === this.generation && this.shouldCacheValue(value)) {
        this.items.set(cacheKey, value);
        if (this.items.size > this.capacity) {
          const oldestKey = this.items.keys().next().value;
          if (oldestKey !== undefined) this.items.delete(oldestKey);
        }
      }
      return value;
    })().finally(() => {
      if (this.inFlight.get(cacheKey) === promise) this.inFlight.delete(cacheKey);
    });
    this.inFlight.set(cacheKey, promise);
    return await promise;
  }

  public clear(): void {
    // Fetches started before clear() must neither store their value nor be joined afterwards.
    this.generation++;
    this.items.clear();
    this.inFlight.clear();
  }
}
