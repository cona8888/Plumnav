import {readFile,writeFile,mkdir,readdir} from 'node:fs/promises'
import {dirname} from 'node:path'
import {createHash} from 'node:crypto'
import {gzipSync} from 'node:zlib'
import {SimulationEngine} from '../src/sim/engine'
import {LocalMaximumProbe} from '../src/sim/algorithms/localMaximumProbe'
import {type VisibleInverseData} from './lib/periodic-inverse'
import {fitAdaptive} from './lib/adaptive-inverse'
const root='research/evidence/m96_adaptive_transfer_2026-09-14',sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex')
const parent=JSON.parse(await readFile('research/evidence/m87_model_selection_2026-09-13/manifest.json','utf8')),base=parent.base,p=base.localInletSampling,delay=Math.PI*(p.tubeInnerDiameterMetres/2)**2*p.tubeLengthMetres/(p.flowLitresPerMinutePerChannel*1e-3/60),response={delay,rise:p.riseTimeConstantSeconds,recovery:p.recoveryTimeConstantSeconds,average:p.averagingSeconds}
const cases=[]
for(const field of ['uniform','peak','offset-peak','ridge','plateau','blank'])for(const period of [0,37,71])for(const phase of [.37])for(const truthScale of [1,2])for(const seed of [96001,96002])cases.push({field,period,phase,truthScale,seed})
await mkdir(root,{recursive:true});const sources=[],inventory:any[]=[]
async function snapshot(file:string){const b=await readFile(file);await mkdir(dirname(`${root}/source-snapshot/${file}`),{recursive:true});await writeFile(`${root}/source-snapshot/${file}`,b,{flag:'wx'});sources.push({file,sha256:sha(b)})}
async function walk(dir:string){for(const e of await readdir(dir,{withFileTypes:true})){const f=`${dir}/${e.name}`;if(e.isDirectory())await walk(f);else if(f.endsWith('.ts'))await snapshot(f)}}
await walk('src/sim');for(const f of ['scripts/m96-adaptive-transfer.ts','scripts/lib/periodic-inverse.ts','scripts/lib/offset-inverse.ts','scripts/lib/adaptive-inverse.ts','scripts/lib/channel-reference.ts'])await snapshot(f)
async function retain(file:string,data:unknown,gzip=false){const b=Buffer.from(JSON.stringify(data)+'\n'),out=gzip?gzipSync(b):b;await writeFile(`${root}/${file}`,out,{flag:'wx'});inventory.push({file,sha256:sha(out)})}
await retain('manifest.json',{cases,base,response,sources,protocol:{duration:600,repeatStart:240,amplitude:.08,scope:'72 fresh verification missions: six spatial fields, three temporal periods (0/37/71), two response profiles and two new seeds; fixed phase .37. Training-adequate centred model preferred; offset model used only when centred training RMSE exceeds unchanged threshold. No validation-based rescue. Not end-to-end GSL.',fitInputs:'Measured retained samples, candidate-relative poses and nominal response only. True scale/period/phase/field never passed to fit.'}})
const rows=[],started=Date.now();let maxRssBytes=0
for(const [index,spec] of cases.entries()){
 const config=structuredClone(base);config.seed=spec.seed;config.durationSeconds=600;config.checkpointSeconds=[600];config.robotStartPositionOverride={x:.5,y:.5};const p=config.localInletSampling
 p.riseTimeConstantSeconds*=spec.truthScale;p.recoveryTimeConstantSeconds*=spec.truthScale;config.sensorLag=p.riseTimeConstantSeconds;p.inspection.settlingSeconds=delay-Math.log(.05)*Math.max(p.riseTimeConstantSeconds,p.recoveryTimeConstantSeconds)+p.averagingSeconds;p.inspection.dwellSeconds=Math.max(12,Math.ceil(p.inspection.settlingSeconds+4));config.activeSniffCycleSeconds=p.inspection.dwellSeconds;p.inspection.maximumPairSeparationSeconds=2*p.inspection.dwellSeconds+2
 const engine=new SimulationEngine(config),trace:any[]=[],probes:LocalMaximumProbe[]=[]
 engine.plume.concentrationAt=(p,t)=>{const x=(p.x-.5)*config.domainMeters,y=(p.y-.5)*config.domainMeters,r=Math.hypot(x,y);let c=0;if(spec.field==='uniform')c=1;if(spec.field==='peak')c=.01+Math.exp(-r*r/(2*.6**2));if(spec.field==='offset-peak')c=.01+Math.exp(-((x-.03)**2+(y+.02)**2)/(2*.6**2));if(spec.field==='ridge')c=.01+Math.exp(-x*x/(2*.6**2));if(spec.field==='plateau')c=r<=.3?1:.01+.99*Math.exp(-((r-.3)**2)/(2*.6**2));return c*(1+(spec.period?.08*Math.sin(2*Math.PI*t/spec.period+spec.phase):0))}
 const start=(time:number)=>{const probe=new LocalMaximumProbe(engine.environment);probes.push(probe);probe.start({time,dt:.25,position:engine.getFrame().robot.position,heading:0,distance:0,observations:[],measurement:{time,concentration:0,valid:false,hit:false,sampleMode:'passive',wind:{x:0,y:0}}},{x:.5,y:.5})}
 start(0);engine.controller.step=input=>{const decision=probes.at(-1)!.step(input)??{direction:{x:0,y:0},speedScale:0,estimate:null,confidence:0,phase:'VERIFICATION FIXTURE HOLD'};trace.push({time:input.time,position:input.position,measurement:input.measurement,decision});return decision}
 while(!engine.isCompleted()){if(trace.length===960)start(240);engine.step()}
 const results=probes.map(p=>p.snapshot().results[0]);if(results.some(r=>!r)||results[0].completedAt>=240)throw Error('Incomplete/overlapping rounds')
 const data:VisibleInverseData={poses:trace.map(t=>({time:t.time,x:(t.position.x-.5)/p.inspection.offsetNormalized,y:(t.position.y-.5)/p.inspection.offsetNormalized})),samples:[]}
 for(const [round,result] of results.entries())for(const [visit,v] of result.visits.entries())for(const s of v.samples){const k=Math.round(s.time/.25);data.samples.push({index:k,value:trace[k].measurement.concentration,hit:trace[k].measurement.hit,train:(round?[0,3,4,7,8]:[0,1,4,5,8]).includes(visit)})}
 data.poses=data.poses.slice(0,Math.max(...data.samples.map(s=>s.index))+1);const fits=[]
 for(const scale of [null,.8,1,1.2]){const settings=scale===null?null:{...response,rise:response.rise*scale,recovery:response.recovery*scale};fits.push({scale,response:settings,...fitAdaptive(data,settings,config.sensorNoise)})}
 const plausible=fits.filter(f=>f.scale!==null&&f.trainingPlausible),summary={...spec,index,instantaneous:fits[0]!.supported,fixed:fits.find(f=>f.scale===1)!.supported,uncertainty:plausible.length>0&&plausible.every(f=>f.supported),plausible:plausible.map(f=>f.scale)}
 await retain(`run-${index}.json.gz`,{summary,config,results,trace,data,fits},true);rows.push(summary);maxRssBytes=Math.max(maxRssBytes,process.memoryUsage().rss);if(index%16===15)process.stdout.write(`${index+1}/${cases.length}\n`)
}
await retain('summary.json',{rows});await retain('runtime.json',{elapsedSeconds:(Date.now()-started)/1000,maxRssBytes});await writeFile(`${root}/complete.json`,JSON.stringify({complete:true,cases:cases.length,inventory})+'\n',{flag:'wx'})
