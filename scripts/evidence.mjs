import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
export function packageContent(manifest) {
 return createHash('sha256').update(JSON.stringify(Object.entries(manifest.package.fileSha256).sort(([a],[b])=>a.localeCompare(b)))).digest('hex');
}
export function suiteEvidence() {
 const files = ['package.json','package-lock.json','candidate.json','docs/review-matrix.json'];
 for (const directory of ['scripts','test','types','.github/workflows']) {
  for (const entry of readdirSync(join(root,directory),{withFileTypes:true})) if (entry.isFile()) files.push(`${directory}/${entry.name}`);
 }
 const hash=createHash('sha256');
 for (const path of files.sort()) { hash.update(path);hash.update('\0');hash.update(readFileSync(join(root,path)));hash.update('\0'); }
 const git=args=>execFileSync('git',args,{cwd:root,encoding:'utf8',timeout:10_000}).trim();
 return { revision:git(['rev-parse','HEAD']),dirty:git(['status','--porcelain','--untracked-files=all']).length>0,inputSha256:hash.digest('hex') };
}
