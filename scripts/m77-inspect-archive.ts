import { readFile } from 'node:fs/promises'
import { auditAcquisitionReturns } from './lib/acquisition-return-audit'
const run = JSON.parse(await readFile('research/evidence/m76_inspection_lifecycle_2026-09-13/run-11.json', 'utf8'))
process.stdout.write(JSON.stringify(auditAcquisitionReturns(run.trace, run.config), null, 2) + '\n')
