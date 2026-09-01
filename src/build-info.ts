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

const raw = JSON.parse(readFileSync(buildInfoPath, 'utf8')) as BuildInfo;

// Placeholders are substituted by the release pipeline only, so keep local builds readable.
const buildInfo: BuildInfo = {
  ...raw,
  version: raw.version.startsWith('REPLACE_WITH') ? 'dev' : raw.version,
};

export default buildInfo;
