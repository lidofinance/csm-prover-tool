export type PMTModule = typeof import('@chainsafe/persistent-merkle-tree');

let cached: PMTModule | undefined;
let pending: Promise<PMTModule>;

export async function loadPMT(): Promise<PMTModule> {
  if (cached) return cached;
  if (!pending) {
    pending = eval(`import('@chainsafe/persistent-merkle-tree').then((m) => {
      cached = m;
      return m;
    })`);
  }
  return pending;
}

void loadPMT().catch(() => undefined);
