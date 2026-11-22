// Rewrites the generated part of docs/contract.md from the registry (GEN-099 C6).
import { readFileSync, writeFileSync } from 'node:fs';
import { CONTRACT_DOC_BEGIN, CONTRACT_DOC_END, renderContractDocs } from '../src/contract/index.ts';

const file = new URL('../../../docs/contract.md', import.meta.url);
const doc = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const begin = doc.indexOf(CONTRACT_DOC_BEGIN);
const end = doc.indexOf(CONTRACT_DOC_END);
if (begin < 0 || end < begin) throw new Error('docs/contract.md has no contract markers');
writeFileSync(file, doc.slice(0, begin) + renderContractDocs() + doc.slice(end + CONTRACT_DOC_END.length));
console.log('docs/contract.md updated');
