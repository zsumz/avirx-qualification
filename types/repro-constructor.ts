// This valid public consumer fails on the declared TypeScript 5.0.4 floor.
// Run the commands in docs/findings.md; do not mark the call as an expected error.
import { avirx } from 'avirx';

const api = avirx('http://127.0.0.1:1');
api.get('/{constructor}').path({ constructor: 'value' });
