import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {CAMPAIGN,campaignSpecs,makeCampaignTrace} from './lib/outdoor-budget-campaign'
const cases=campaignSpecs('campaign'),smoke=campaignSpecs('smoke')
assert.equal(cases.length,544);assert.equal(cases.filter(s=>s.resolution===0).length,512)
assert.equal(new Set(cases.map(s=>JSON.stringify(s))).size,544)
assert.equal(new Set(cases.map(s=>s.world)).size,128)
assert.deepEqual([...new Set(cases.filter(s=>s.resolution>0).map(s=>s.world))],CAMPAIGN.witnessWorlds)
assert.equal(smoke.length,4);assert.ok(smoke.every(s=>s.world===200&&s.resolution===0))
assert.throws(()=>campaignSpecs('bad' as 'smoke'))
assert.throws(()=>makeCampaignTrace({world:200,wind:.5,speed:1,resolution:0},'campaign'))
assert.throws(()=>makeCampaignTrace({world:2001,wind:.5,speed:1,resolution:1},'campaign'))
assert.throws(()=>makeCampaignTrace({world:2000,wind:.5,speed:1,resolution:0},'smoke'))
const old=readFileSync('scripts/lib/outdoor-budget.ts','utf8'),current=readFileSync('scripts/lib/outdoor-budget-campaign.ts','utf8')
const scientific=(s:string)=>s.slice(s.indexOf('  const r = DESIGN.resolutions[spec.resolution]!')).trim().replace('schemaVersion: CAMPAIGN.version','schemaVersion: BUDGET.version')
assert.equal(scientific(current),scientific(old),'Scientific generation body must remain verbatim')
assert.equal(CAMPAIGN.primaryOutcomes,512*4*2);assert.ok(CAMPAIGN.maxRuntimeSeconds>1762)
console.log('PASS: 544-case inventory, 128 independent world IDs, 16 witnesses, 4096 paired outcomes, guards, and exact scientific-body compatibility.')
