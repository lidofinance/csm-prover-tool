import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export function getModuleStorageDir(stakingModuleAddress: string): string {
  const dir = join('storage', stakingModuleAddress.toLowerCase());
  mkdirSync(dir, { recursive: true });
  return dir;
}
