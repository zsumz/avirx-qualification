import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const root = new URL('../', import.meta.url);
export function assertCandidate() {
 const manifest = JSON.parse(readFileSync(new URL('artifacts/candidate.json', root), 'utf8'));
 const metadata = JSON.parse(readFileSync(new URL('node_modules/avirx/package.json', root), 'utf8'));
 if (metadata.name !== manifest.package.name || metadata.version !== manifest.package.version) throw Error('Installed candidate metadata differs from qualification manifest. Run npm run candidate.');
 const files = manifest.package.fileSha256;
 if (!files || Object.keys(files).length === 0) throw Error('Candidate manifest lacks file hashes; run npm run candidate.');
 for (const [path, expected] of Object.entries(files)) {
  if (path.startsWith('/') || path.split('/').includes('..')) throw Error('Unsafe manifest path.');
  const actual = createHash('sha256').update(readFileSync(new URL(`node_modules/avirx/${path}`, root))).digest('hex');
  if (actual !== expected) throw Error(`Installed candidate file differs: ${path}. Run npm run candidate.`);
 }
 return manifest;
}
