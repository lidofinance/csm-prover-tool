import { readdirSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { defineConfig } from '@wagmi/cli';

const ABI_DIR = 'src/common/contracts/abi';

const abiFiles = readdirSync(ABI_DIR).filter((file) => file.endsWith('.json'));

export default defineConfig(
  abiFiles.map((file) => {
    const name = basename(file, '.json');
    const abi = JSON.parse(readFileSync(`${ABI_DIR}/${file}`, 'utf8'));
    return { out: `${ABI_DIR}/${name}.ts`, contracts: [{ name, abi }] };
  }),
);
