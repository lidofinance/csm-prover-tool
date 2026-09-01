import { readFileSync } from 'node:fs';

// Overwritten in the image by the Dockerfile from BUILD_* build args.
export default JSON.parse(readFileSync(new URL('../build-info.json', import.meta.url), 'utf8')) as {
  version: string;
  branch: string;
  commit: string;
};
