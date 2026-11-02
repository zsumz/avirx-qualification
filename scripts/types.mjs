import { suiteEvidence, packageContent } from './evidence.mjs';
import { spawnSync } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { assertCandidate } from './provenance.mjs';

const candidate = assertCandidate();
const suite = suiteEvidence();
const root = fileURLToPath(new URL('..', import.meta.url));
const source = await readFile(new URL('../types/consumer.ts', import.meta.url), 'utf8');
const negativeCases = (source.match(/@ts-expect-error/g) ?? []).length;
const results = [];
for (const dependency of ['typescript-minimum', 'typescript', 'typescript-current']) {
    const packageJson = JSON.parse(await readFile(new URL(`../node_modules/${dependency}/package.json`, import.meta.url), 'utf8'));
    const result = spawnSync(process.execPath, [
        fileURLToPath(new URL(`../node_modules/${dependency}/bin/tsc`, import.meta.url)),
        '-p', 'types/tsconfig.json',
    ], { cwd: root, encoding: 'utf8', timeout: 60_000 });
    const record = {
        dependency, version: packageJson.version, negativeCases,
        status: result.status === 0 ? 'passed' : 'failed',
        exitCode: result.status,
        diagnostics: `${result.stdout ?? ''}${result.stderr ?? ''}${result.error ? `\n${result.error.message}` : ''}`.trim(),
    };
    results.push(record);
    console.log(`TypeScript ${record.version}: ${record.status}; ${negativeCases} negative consumer cases`);
    if (record.diagnostics) console.log(record.diagnostics);
}
await mkdir(new URL('../artifacts/', import.meta.url), { recursive: true });
await writeFile(new URL('../artifacts/types.json', import.meta.url), `${JSON.stringify({
    generatedAt: new Date().toISOString(), node: process.version,
    suite, packageContentSha256: packageContent(candidate), candidateCommit: candidate.candidateCommit, integrity: candidate.package.integrity, results,
}, null, 2)}\n`);
if (results.some(result => result.status !== 'passed')) process.exitCode = 1;
