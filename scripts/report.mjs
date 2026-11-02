import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
const files = readdirSync('artifacts').filter(f => f.endsWith('.json') && f !== 'summary.json');
const reports = Object.fromEntries(files.map(f => [f, JSON.parse(readFileSync(`artifacts/${f}`))]));
writeFileSync('artifacts/summary.json', JSON.stringify({ generatedAt: new Date().toISOString(), reports }, null, 2) + '\n');
console.log(JSON.stringify({ reports: files }, null, 2));
