import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {fineSchedulingCases,WITNESS_WORLDS} from './lib/si-fine-scheduling-design'
import {integrationConfig} from './lib/si-integration'
const cases=fineSchedulingCases('campaign'),prior=JSON.parse(await readFile('research/evidence/si_linear_fresh_2026-09-17/manifest.json','utf8'))
assert.equal(cases.length,288);assert.equal(new Set(cases.map(s=>s.index)).size,288)
assert.equal(cases.filter(s=>s.caseRole==='primary').length,192)
for(let w=0;w<16;w++){
 const rows=cases.filter(s=>s.worldIndex===w)
 assert.equal(rows.length,WITNESS_WORLDS.includes(w)?36:12)
 for(const key of ['worldSeed','sourceSeed','startSeed','controllerSeed','replicate'] as const){assert.equal(new Set(rows.map(s=>s[key])).size,1);assert.ok(!prior.cases.some((p:any)=>p[key]===rows[0]![key]))}
 for(const s of rows){const c=integrationConfig(s);assert.equal(c.fixedDt,s.navDt);assert.equal(c.domainMeters,10);assert.equal(c.sensorNoise,.001);assert.equal(c.localInletSampling!.opposingInletSpacingMetres,.1)}
}
const preflight=fineSchedulingCases('preflight');assert.equal(preflight.length,4)
assert.deepEqual(preflight.map(s=>s.index),[2,5,8,11]);assert.equal(new Set(preflight.map(s=>s.index%4)).size,4)
for(const s of preflight){const old=prior.cases.find((p:any)=>p.index===s.index);assert.deepEqual(integrationConfig(s),integrationConfig(old))}
assert.throws(()=>fineSchedulingCases('invalid' as any))
console.log('PASS 288 frozen-design cases, 192 fine primaries, 48 witness triplets, paired/new seeds and 4 exact-config references')
