import { suiteEvidence, packageContent } from './evidence.mjs';
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join, basename, dirname } from 'node:path';
import { assertCandidate } from './provenance.mjs';
const candidate = assertCandidate();
const suite = suiteEvidence();
const root = resolve(import.meta.dirname, '..');
const at = process.argv.indexOf('--evidence');
const evidenceRoot = resolve(root, at >= 0 ? process.argv[at + 1] : 'artifacts');
const matrix = JSON.parse(readFileSync(join(root, 'docs/review-matrix.json')));
function walk(path) { return readdirSync(path, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(join(path, entry.name)) : [join(path, entry.name)]); }
const files = walk(evidenceRoot);
const nodes = []; const browsers = []; const compilers = []; const ignored = [];
for (const path of files.filter(f => f.endsWith('.json'))) {
 let value; try { value = JSON.parse(readFileSync(path)); } catch { continue; }
 if (basename(path).startsWith('run-') && value.results) {
  if (value.candidateCommit !== candidate.candidateCommit || value.packageContentSha256 !== packageContent(candidate) || value.suite?.inputSha256 !== suite.inputSha256) { ignored.push(basename(path)); continue; }
  for (const lane of value.results.filter(r => r.name === 'node' || r.name.startsWith('soak-'))) {
   const log = join(dirname(path), `${lane.name}.log`);
   if (!existsSync(log)) continue;
   for (const match of readFileSync(log, 'utf8').matchAll(/^\s*(ok|not ok) \d+ - (.+)$/gm)) nodes.push({ name: match[2], status: match[1] === 'ok' && !/# (SKIP|TODO)/.test(match[2]) ? 'passed' : 'failed', lane: lane.name, laneStatus: lane.status === 'passed' && lane.skipped === 0 && lane.cancelled === 0 ? 'passed' : 'failed' });
  }
 } else if (value.engine && Array.isArray(value.checks)) {
  if (value.candidateCommit !== candidate.candidateCommit || value.packageContentSha256 !== packageContent(candidate) || value.suite?.inputSha256 !== suite.inputSha256) { ignored.push(basename(path)); continue; }
  browsers.push(value);
 } else if (basename(path) === 'types.json' && value.results) {
  if (value.candidateCommit !== candidate.candidateCommit || value.packageContentSha256 !== packageContent(candidate) || value.suite?.inputSha256 !== suite.inputSha256) { ignored.push(basename(path)); continue; }
  compilers.push(...value.results);
 }
}
const rows = matrix.rows.map(row => {
 const node = row.nodePatterns.map(pattern => {
  const matches = nodes.filter(test => new RegExp(pattern).test(test.name));
  return { pattern, cases: [...new Set(matches.map(test => test.name))].length, status: matches.length && matches.every(test => test.status === 'passed' && test.laneStatus === 'passed') ? 'passed' : matches.length ? 'failed' : 'not-run' };
 });
 const browser = row.browserIds.flatMap(id => ['chromium','firefox','webkit'].map(engine => {
  const reports = browsers.filter(report => report.engine === engine);
  const checks = reports.flatMap(report => report.checks.filter(check => check.id === id).map(check => ({ ...check, enginePassed: report.status === 'passed' && (report.cleanupErrors?.length ?? 0) === 0 })));
  return { engine, id, status: checks.length && checks.every(check => check.status === 'passed' && check.enginePassed) ? 'passed' : checks.length ? 'failed' : 'not-run' };
 }));
 const types = row.compilers.map(version => {
  const matches = compilers.filter(report => report.version === version);
  return { version, status: matches.length && matches.every(report => report.status === 'passed') ? 'passed' : matches.length ? 'failed' : 'not-run' };
 });
 const outcomes = [...node,...browser,...types].map(result => result.status);
 return { ...row, status: outcomes.every(status => status === 'passed') ? 'passed' : outcomes.includes('failed') ? 'failed' : 'not-run', node, browser, types };
});
const report = { generatedAt: new Date().toISOString(), suite, packageContentSha256: packageContent(candidate), candidateCommit: candidate.candidateCommit, baselineCommit: candidate.baselineCommit, packageIntegrity: candidate.package.integrity, rows, ignoredOtherCandidateReports: [...new Set(ignored)], limits: 'Evidence mapping checks observed passing IDs, not assertion quality or exhaustive behavior. Independent review and complete CI gates remain required.' };
writeFileSync(join(root, 'artifacts/review-coverage.json'), JSON.stringify(report, null, 2)+'\n');
const markdown = ['# Review-to-test evidence', '', `Candidate: \`${candidate.candidateCommit}\`. Merged baseline: \`${candidate.baselineCommit}\`. The fix candidate is unmerged.`, '', 'Each ID maps the original review line range to named tests and recorded outcomes. The original attachment is not republished. Full selectors are in [review-matrix.json](review-matrix.json); generated evidence comes from candidate-matched TAP, compiler and native browser records.', '', '| ID / review lines | Concern and test IDs | Evidence | Limits |', '| --- | --- | --- | --- |', ...rows.map(row => `| ${row.id} / ${row.reviewLines.join('–')} | ${row.concern}; ${[...row.nodePatterns.map(p => `\`${p}\``),...row.browserIds.map(id => `\`${id}\``),...(row.compilers.length ? ['strict installed compiler consumers'] : [])].join(', ')} | ${row.status}; ${row.node.reduce((sum,r)=>sum+r.cases,0)} selector matches, ${row.browser.filter(result=>result.status !== 'not-run').length}/${row.browser.length} observed/expected browser ID/engine checks, ${row.types.length} compilers | ${row.limits} |`), '', 'Selector matches can overlap; they are not a unique test count. Nonblocking maintainability/history/release discussion is classified in the JSON matrix. No row claims every permutation, runtime or timing interleaving.'];
writeFileSync(join(root, 'artifacts/review-matrix.md'), markdown.join('\n')+'\n');
console.log(JSON.stringify({ candidateCommit: candidate.candidateCommit, rows: Object.fromEntries(['passed','failed','not-run'].map(status => [status, rows.filter(row => row.status === status).length])) }, null, 2));
if (rows.some(row => row.status !== 'passed')) process.exitCode = 1;
