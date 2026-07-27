import { readFileSync } from 'node:fs';

const packageInfo = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  name: string;
};

export default packageInfo;
