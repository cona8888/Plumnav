import type { Vec2 } from '../../src/sim/types'
import { M21_NUISANCES, m21Calibrate } from './m21-direction-study'
import { m24Angle, m24Episode, M24_DYNAMICS } from './m24-time-aware'
import { M23_ANGLES } from './m23-rotation-transfer'
import { m26Maps } from './m26-action-horizon'
import { executeM28Action } from './m28-continuous-feasible'

export const M29_DESIGN = { actionSeconds: 1, minimumForecastAlignment: 0.98, calibrationReplicates: 2, trials: 5,
  expectedEpisodes: 49280, expectedActions: 197120, calibrationSeedBase: 65000, episodeSeedBase: 5000000,
  acceptanceFloorPerCell: 0.5, fullDistanceFraction: 0.99, positiveGainOverall: 0.95, positiveGainCell: 0.90,
  movementExecuted: true, newSensorCycles: 197120, gslTrajectories: 0, appPromoted: false } as const
const rotate = (v: Vec2, a: number) => ({ x: v.x * Math.cos(a) - v.y * Math.sin(a), y: v.x * Math.sin(a) + v.y * Math.cos(a) })
export const runM29 = () => {
  const maps=m26Maps(),cells=new Map<string,{map:string;dynamic:string;nuisance:string;actions:number;follows:number;explores:number;fullDistance:number;positiveFollowGain:number;collisions:number;blockedEndpoints:number;distance:number;gain:number;alignment:number}>();let episodes=0,actions=0
  for(const [ni,n] of M21_NUISANCES.entries())for(let rep=0;rep<2;rep++){const calibration=m21Calibrate(n,M29_DESIGN.calibrationSeedBase+ni*2+rep).calibration
    for(const [di,dynamic] of M24_DYNAMICS.entries())for(const [pi,phase] of M23_ANGLES.entries())for(const [bi,body] of M23_ANGLES.entries())for(let trial=0;trial<5;trial++){
      const seed=M29_DESIGN.episodeSeedBase+ni*200000+rep*100000+di*8000+pi*800+bi*10+trial,e=m24Episode(n,dynamic,phase,body,seed,calibration),decision=e.decisions.find(d=>d.arm==='time-aware')!;episodes++
      const forecast=decision.direction?rotate(decision.direction,decision.fittedRate!*M29_DESIGN.actionSeconds):null,truth=m24Angle(dynamic,phase,12.5),truthDirection={x:Math.cos(truth),y:Math.sin(truth)}
      for(const map of maps){const preview=forecast?executeM28Action(map,forecast):null,follow=!!forecast&&preview!.meanAlignment>=M29_DESIGN.minimumForecastAlignment,desired=follow?forecast!:{x:Math.cos(body+Math.PI/2),y:Math.sin(body+Math.PI/2)},moved=follow?preview!:executeM28Action(map,desired),delta={x:moved.position.x-map.start.x,y:moved.position.y-map.start.y},gain=4*(truthDirection.x*delta.x+truthDirection.y*delta.y),key=`${map.id}|${dynamic.id}|${n.id}`,c=cells.get(key)??{map:map.id,dynamic:dynamic.id,nuisance:n.id,actions:0,follows:0,explores:0,fullDistance:0,positiveFollowGain:0,collisions:0,blockedEndpoints:0,distance:0,gain:0,alignment:0};c.actions++;c.follows+=Number(follow);c.explores+=Number(!follow);c.fullDistance+=Number(moved.distance>=.0099);c.positiveFollowGain+=Number(follow&&gain>1e-12);c.collisions+=moved.collisions;c.blockedEndpoints+=Number(moved.blockedEndpoint);c.distance+=moved.distance;c.gain+=gain;c.alignment+=moved.meanAlignment;cells.set(key,c);actions++}
    }}
  const aggregates=[...cells.values()],supported=aggregates.filter(c=>c.nuisance!=='slow'),follows=supported.reduce((s,c)=>s+c.follows,0),positives=supported.reduce((s,c)=>s+c.positiveFollowGain,0),failures={safety:aggregates.filter(c=>c.blockedEndpoints>0),distance:aggregates.filter(c=>c.fullDistance/c.actions<M29_DESIGN.fullDistanceFraction),acceptance:supported.filter(c=>c.follows/c.actions<M29_DESIGN.acceptanceFloorPerCell),gainCells:supported.filter(c=>c.follows>=20&&c.positiveFollowGain/c.follows<M29_DESIGN.positiveGainCell),slowFollow:aggregates.filter(c=>c.nuisance==='slow'&&c.follows>0),overallGain:positives/follows}
  return{complete:true,design:M29_DESIGN,mapManifest:maps.map(m=>({id:m.id,complexity:m.complexity,seed:m.seed,start:m.start,localAvoidanceChallenge:m.localAvoidanceChallenge,obstacles:m.scenario.obstacles})),episodes,actions,aggregates,failures,advancesToReacquisitionTest:!failures.safety.length&&!failures.distance.length&&!failures.acceptance.length&&!failures.gainCells.length&&!failures.slowFollow.length&&failures.overallGain>=M29_DESIGN.positiveGainOverall,movementExecuted:true,newSensorCycles:episodes*4,gslTrajectories:0,appPromoted:false}
}
