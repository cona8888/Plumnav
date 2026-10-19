import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {responseCases,responseConfig,responsePlan} from './lib/si-response-design'
import {integrationConfig} from './lib/si-integration'
import {stage1iStableJson as json} from './lib/stage1i-campaign-design'
const fallback=responseCases('nominal-only'),pre=responseCases('nominal-preflight')
assert.equal(pre.length,12);assert.equal(pre.filter(s=>s.caseRole==='compatibility').length,12)
assert.equal(fallback.length,480);assert.equal(fallback.filter(s=>s.caseRole==='primary').length,384)
assert.equal(new Set(fallback.map(s=>s.index)).size,480)
const frozen=JSON.parse(readFileSync('aws/build/stage2i-20260921-v1/bundle.json','utf8'))
assert.equal(json(fallback),json(frozen.plan['nominal-only'].cases))
assert.equal(json(pre),json(frozen.plan.preflight.cases.filter((s:{caseRole:string})=>s.caseRole==='compatibility')))
for(const s of [...fallback,...pre]){
 const c=responseConfig(s),base=integrationConfig(s),p=c.localInletSampling!,b=base.localInletSampling!
 assert.equal(p.riseTimeConstantSeconds,b.riseTimeConstantSeconds*s.responseScale)
 assert.equal(p.recoveryTimeConstantSeconds,b.recoveryTimeConstantSeconds*s.responseScale)
 p.riseTimeConstantSeconds=b.riseTimeConstantSeconds;p.recoveryTimeConstantSeconds=b.recoveryTimeConstantSeconds
 assert.equal(json(c),json(base))
}
assert.throws(()=>responseConfig({...fallback[0]!,responseScale:2}),/Inconsistent inspection geometry\/timing/)
for(let w=0;w<32;w++){
 const rows=fallback.filter(s=>s.worldIndex===w)
 for(const key of ['worldSeed','sourceSeed','startSeed','controllerSeed','replicate'] as const)assert.equal(new Set(rows.map(s=>s[key])).size,1)
 assert.equal(rows.filter(s=>s.caseRole==='primary').length,12)
}
assert.equal(json(responsePlan()['nominal-only']!.cases),json(fallback))
assert.throws(()=>responseCases('campaign' as 'nominal-only'))
assert.throws(()=>responseCases('preflight' as 'nominal-only'))
assert.throws(()=>responseConfig({...fallback[0]!,responseScale:3 as 1}))
let expected=readFileSync('scripts/lib/si-linear-integration.ts','utf8')
 .replace('import {integrationConfig,publicEnvironment','import {publicEnvironment')
 .replace("import type {LinearSpec} from './si-linear-design'","import {responseConfig as integrationConfig,type ResponseSpec as LinearSpec} from './si-response-design'")
 .replaceAll('runLinearIntegration','runResponseIntegration').replaceAll('replayLinearIntegration','replayResponseIntegration')
 .replace('c.robotStartHeadingDegrees*Math.PI','c.robotStartHeadingDegrees!*Math.PI')
assert.equal(readFileSync('scripts/lib/si-response-integration.ts','utf8'),expected)
console.log('PASS: exact prospective fallback, all 492 configurations validated, paired seeds, slow timing rejected, disabled full campaign, mechanical run-loop identity (one type-only assertion)')
