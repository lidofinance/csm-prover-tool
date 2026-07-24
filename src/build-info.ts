import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

type BuildInfo = {
  version: string;
  branch: string;
  commit: string;
};

const currentDir = dirname(fileURLToPath(import.meta.url));
const buildInfoPath = resolve(currentDir, '../build-info.json');

const buildInfo = JSON.parse(readFileSync(buildInfoPath, 'utf8')) as BuildInfo;

export default buildInfo;
