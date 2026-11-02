import { suiteEvidence, packageContent } from './evidence.mjs';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { assertCandidate } from './provenance.mjs';
const root = resolve(import.meta.dirname, '..');
const candidate = assertCandidate();
const suite = suiteEvidence();
function sanitize(value) {
 if (typeof value === 'string') {
  for (const [path,label] of [[root,'<qualification>'],[homedir(),'<home>'],[tmpdir(),'<tmp>']]) if (path.length > 1) value=value.split(path).join(label);
  return value.replace(/\/(?:Users|home)\/[^\s/"']+\/[^\s"']*/g,'<local-path>').replace(/\/(?:private\/)?var\/folders\/[^\s"']*/g,'<temporary-path>');
 }
 if (Array.isArray(value)) return value.map(sanitize);
 if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,sanitize(item)]));
 return value;
}
const reports={};
for (const name of ['run-fast.json','run-soak.json','types.json','browser-chromium.json','browser-firefox.json','browser-webkit.json','review-coverage.json']) {
 const path=join(root,'artifacts',name); if (!existsSync(path)) { reports[name]={status:'not-run'}; continue; }
 const report=JSON.parse(readFileSync(path));
 if (report.candidateCommit !== candidate.candidateCommit || report.packageContentSha256 !== packageContent(candidate) || report.suite?.inputSha256 !== suite.inputSha256) reports[name]={status:'not-run',reason:'Existing report belongs to another candidate, package content, or suite input.'};
 else reports[name]=sanitize(report);
}
const snapshot={generatedAt:new Date().toISOString(),suite,packageContentSha256:packageContent(candidate),candidateCommit:candidate.candidateCommit,baselineCommit:candidate.baselineCommit,candidatePullRequest:candidate.candidatePullRequest,packageIntegrity:candidate.package.integrity,toolchain:candidate.toolchain,reports,scope:'Local measured evidence. CI native Firefox and maintained Node matrix are separate. The product candidate is unmerged.'};
mkdirSync(join(root,'docs/results'),{recursive:true});
writeFileSync(join(root,'docs/results/current-local.json'),JSON.stringify(snapshot,null,2)+'\n');
console.log('Recorded sanitized candidate-matched local evidence; baseline snapshots preserved.');
