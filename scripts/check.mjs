import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const files = [];
for (const dir of ['server', 'scripts']) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isFile() && /\.(?:m?js)$/.test(entry.name)) files.push(join(dir, entry.name));
  }
}

for (const file of files.sort()) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}

console.log(`Syntax check passed (${files.length} files).`);
