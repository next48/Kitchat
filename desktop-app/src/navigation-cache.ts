// Bounded, account-scoped memory cache. Never persists messages or tokens to disk.
export class NavigationCache<T> {
  private values = new Map<string, { value: T; at: number }>();
  private pending = new Map<string, Promise<T>>();
  private generation = 0;
  clear() { this.generation++; this.values.clear(); this.pending.clear(); }
  async load(key: string, fetcher: () => Promise<T>): Promise<T> {
    const cached = this.values.get(key);
    const refresh = () => {
      const existing = this.pending.get(key);
      if (existing) return existing;
      const generation = this.generation;
      const task = fetcher().then(value => {
        if (generation === this.generation) {
          this.values.delete(key);
          this.values.set(key, { value: structuredClone(value), at: Date.now() });
          if (this.values.size > 12) this.values.delete(this.values.keys().next().value!);
        }
        return value;
      }).finally(() => { if (this.pending.get(key) === task) this.pending.delete(key); });
      this.pending.set(key, task);
      return task;
    };
    if (cached && Date.now() - cached.at < 60_000) {
      void refresh().catch(() => {});
      return structuredClone(cached.value);
    }
    return refresh();
  }
}
