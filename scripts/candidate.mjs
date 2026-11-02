import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
const root = resolve(import.meta.dirname, '..');
const pinned = JSON.parse(readFileSync(join(root, 'candidate.json')));
const args = process.argv.slice(2);
function option(name) { const i = args.indexOf(name); if (i < 0) return undefined; if (!args[i + 1] || args[i + 1].startsWith('--')) throw Error(`Missing ${name}`); return args[i + 1]; }
const commit = option('--commit') ?? pinned.commit;
if (!/^[a-f0-9]{40}$/.test(commit)) throw Error('Candidate must be an explicit full commit SHA.');
const external = option('--source');
const source = external ? realpathSync(resolve(external)) : join(root, '.work', 'source');
function run(file, argv, cwd = root, output = false) {
  return execFileSync(file, argv, { cwd, encoding: 'utf8', timeout: 300_000, maxBuffer: 16 * 1024 * 1024, stdio: output ? 'pipe' : 'inherit' });
}
mkdirSync(join(root, '.work'), { recursive: true });
mkdirSync(join(root, 'artifacts'), { recursive: true });
if (!external) {
  if (!existsSync(join(source, '.git'))) run('git', ['clone', pinned.repository, source]);
  try { run('git', ['cat-file', '-e', `${commit}^{commit}`], source, true); }
  catch { run('git', ['fetch', 'origin', commit], source); }
  if (run('git', ['status', '--porcelain', '--untracked-files=all'], source, true).trim()) throw Error('Refusing dirty managed candidate checkout.');
  run('git', ['checkout', '--detach', commit], source);
}
const actual = run('git', ['rev-parse', 'HEAD'], source, true).trim();
if (actual !== commit) throw Error(`Source is ${actual}; expected ${commit}. External checkouts are never modified.`);
if (run('git', ['status', '--porcelain', '--untracked-files=all'], source, true).trim()) throw Error('Refusing dirty tracked source.');
const pkg = JSON.parse(readFileSync(join(source, 'package.json')));
if (pkg.name !== pinned.expectedPackage) throw Error('Unexpected source package.');
if (commit === pinned.commit && pkg.version !== pinned.expectedVersion) throw Error('Pinned package version mismatch.');
run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], source);
run('npm', ['run', 'build'], source);
const pack = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', join(root, '.work')], source, true))[0];
const tgz = join(root, '.work', pack.filename);
const bytes = readFileSync(tgz);
const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
if (integrity !== pack.integrity) throw Error('npm pack integrity mismatch.');
run('npm', ['install', '--ignore-scripts', '--no-save', '--package-lock=false', '--no-audit', '--no-fund', tgz]);
const installed = JSON.parse(readFileSync(join(root, 'node_modules/avirx/package.json')));
if (installed.name !== pkg.name || installed.version !== pkg.version) throw Error('Wrong installed candidate.');
const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex');
if (digest(join(source, 'dist/index.js')) !== digest(join(root, 'node_modules/avirx/dist/index.js'))) throw Error('Installed entry differs from built source.');
const manifest = {
  schemaVersion: 1, generatedAt: new Date().toISOString(), repository: pinned.repository,
  baselineCommit: pinned.commit, candidateCommit: actual, override: actual !== pinned.commit,
  sourceTree: run('git', ['rev-parse', 'HEAD^{tree}'], source, true).trim(),
  package: { name: pkg.name, version: pkg.version, filename: pack.filename, integrity, sha256: createHash('sha256').update(bytes).digest('hex'), unpackedSize: pack.unpackedSize, files: pack.files.map(f => f.path), entrySha256: digest(join(root, 'node_modules/avirx/dist/index.js')), runtimeDependencies: installed.dependencies ?? {}, fileSha256: Object.fromEntries(pack.files.map(f => [f.path, digest(join(root, 'node_modules/avirx', f.path))])) },
  toolchain: { node: process.version, npm: run('npm', ['--version'], root, true).trim(), platform: process.platform, arch: process.arch },
};
writeFileSync(join(root, 'artifacts/candidate.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`Prepared ${pkg.name}@${pkg.version} from ${actual}; ${integrity}`);
