import { suiteEvidence, packageContent } from './evidence.mjs';
import { assertCandidate } from './provenance.mjs';
import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const mode = process.argv[2] ?? 'fast';
if (!['fast', 'runtime', 'soak', 'full'].includes(mode)) throw Error('Use fast, runtime, soak, or full.');
const candidate = assertCandidate();
const suite = suiteEvidence();
mkdirSync(resolve(root, 'artifacts'), { recursive: true });
const results = [];
async function run(name, argv, timeout, env = {}) {
 const start = Date.now();
 let stdout = '', stderr = '', timedOut = false;
 const child = spawn(process.execPath, argv, { cwd: root, env: { ...process.env, ...env }, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
 function kill() { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
 const timer = setTimeout(() => { timedOut = true; kill(); }, timeout);
 const onSignal = () => { kill(); process.exit(130); };
 process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal);
 child.stdout.on('data', b => { stdout += b; process.stdout.write(b); });
 child.stderr.on('data', b => { stderr += b; process.stderr.write(b); });
 const outcome = await new Promise(resolve => { child.on('error', error => resolve({ code: null, error: String(error) })); child.on('close', (code, signal) => resolve({ code, signal })); });
 clearTimeout(timer); process.removeListener('SIGINT', onSignal); process.removeListener('SIGTERM', onSignal);
 writeFileSync(resolve(root, `artifacts/${name}.log`), stdout + stderr);
 const counts = Object.fromEntries([...stdout.matchAll(/^# (tests|pass|fail|cancelled|skipped) (\d+)$/gm)].map(m => [m[1], Number(m[2])]));
 const result = { name, command: ['node', ...argv], status: outcome.code === 0 && !timedOut ? 'passed' : timedOut ? 'timed-out' : 'failed', ...outcome, durationMs: Date.now() - start, ...counts };
 results.push(result); return result;
}
const testArgs = ['--test', '--test-concurrency=1', '--test-reporter=tap', ...readdirSync(resolve(root, 'test')).filter(name => name.endsWith('.test.mjs')).sort().map(name => `test/${name}`)];
if (mode === 'soak') {
 for (const seed of ['1', '3735928559', '1592594996', '4294967295', '20261102']) await run(`soak-${seed}`, testArgs, 180_000, { QUALIFICATION_SEED: seed });
} else {
 await run('node', testArgs, 180_000);
 if (mode !== 'runtime') await run('types', ['scripts/types.mjs'], 190_000);
 await run('compat', ['scripts/node-compat.mjs'], 30_000);
 if (mode === 'full') await run('browsers', ['test/browser.mjs', '--all'], 180_000);
}
writeFileSync(resolve(root, `artifacts/run-${mode}.json`), JSON.stringify({ generatedAt: new Date().toISOString(), mode, suite, packageContentSha256: packageContent(candidate), candidateCommit: candidate.candidateCommit, packageIntegrity: candidate.package.integrity, toolchain: { node: process.version, platform: process.platform, arch: process.arch }, results }, null, 2) + '\n');
if (results.some(r => r.status !== 'passed')) process.exitCode = 1;
