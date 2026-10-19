/** Post-hoc mechanism witness only. Does not alter the frozen campaign or app. */
import assert from 'node:assert/strict'
import {mkdir,readFile,writeFile} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {SimulationEngine} from '../src/sim/engine'
import {integrationCases,integrationConfig} from './lib/si-integration'
import {stage1iSha256 as sha,stage1iStableJson as json} from './lib/stage1i-campaign-design'
const out=process.argv[process.argv.indexOf('--output')+1]
if(!process.argv.includes('--output'))throw Error('Exclusive output required')
await mkdir(out)
const rows:any[]=[],horizon=4,speed=.1,omega=Math.PI/4
for(const degrees of [17,53,137])for(const navDt of [1/16,1/32,1/64,1/128]){
 const spec={...integrationCases().find(s=>s.field==='blank'&&s.method==='coverage')!,navDt,worldSeed:109991,sourceSeed:109992,startSeed:109993,controllerSeed:109994}
 const c=integrationConfig(spec);c.robotStartPositionOverride={x:.5,y:.5};c.robotStartHeadingDegrees=degrees;c.durationSeconds=horizon;c.checkpointSeconds=[horizon]
 const engine=new SimulationEngine(c);engine.controller.step=()=>({direction:{x:1,y:0},speedScale:1,estimate:null,confidence:0,phase:'CONSTANT RIGHTWARD COMMAND'})
 while(!engine.isCompleted())engine.step()
 const turnTime=degrees*Math.PI/180/omega,analyticDistance=speed*(horizon-turnTime)
 const numericalDistance=(engine.getFrame().robot.position.x-.5)*c.domainMeters
 const predictedCredit=speed*(turnTime-Math.floor(turnTime/navDt)*navDt)
 assert.ok(Math.abs(numericalDistance-analyticDistance-predictedCredit)<1e-11)
 assert.ok(numericalDistance-analyticDistance>=-1e-12&&numericalDistance-analyticDistance<speed*navDt+1e-12)
 // Independent closed-form time allocation for the intended rotate-in-place
 // then translate command. No algorithm, field or observation changes.
 let heading=degrees*Math.PI/180,exactDistance=0
 for(let tick=0;tick<Math.round(horizon/navDt);tick++){
  const rotationSeconds=Math.min(navDt,Math.abs(heading)/omega)
  heading-=Math.min(Math.abs(heading),omega*rotationSeconds)
  exactDistance+=speed*(navDt-rotationSeconds)
 }
 assert.ok(Math.abs(exactDistance-analyticDistance)<1e-12)
 rows.push({degrees,navDt,turnTime,analyticDistanceMetres:analyticDistance,engineDistanceMetres:numericalDistance,engineOvercreditMetres:numericalDistance-analyticDistance,predictedOvercreditMetres:predictedCredit,eventExactDistanceMetres:exactDistance,eventExactErrorMetres:Math.abs(exactDistance-analyticDistance)})
}
const sources=await Promise.all(['scripts/diagnose-si-turn-timing.ts','src/sim/engine.ts',fileURLToPath(import.meta.url)].map(async file=>({file,sha256:sha(await readFile(file))})))
const result={postHoc:true,mechanismWitnessOnly:true,doesNotOverrideFrozenGate:true,seed:109991,horizonSeconds:horizon,rows,sources,claim:'The current engine credits a full translation tick on the step in which alignment is completed. A split turn/translation clock removes this error for constant-heading, obstacle-free commands. This does not establish that it is the sole cause of closed-loop divergence or that a replacement autonomous adapter is validated.'}
const body=json(result);await writeFile(`${out}/witness.json`,body,{flag:'wx'});await writeFile(`${out}/complete.json`,json({complete:true,sha256:sha(body),caseCount:rows.length}),{flag:'wx'});process.stdout.write(body)
