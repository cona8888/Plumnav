import {LinearInletChannel} from './si-linear-inlet'
import {SeededRandom} from '../../src/sim/rng'
import type {PlumeModel} from '../../src/sim/plume'
import {integrationConfig} from './si-integration'
import type {MotionPose} from './si-turn-motion'

/** Same physical response and clocks, with the versioned linear-input integrator. */
export class LinearInstrument{
 readonly trace:number[][]=[];private channels:LinearInletChannel[];private noise:SeededRandom;private tick=0
 readout=[0,0,0,0]
 constructor(private c:ReturnType<typeof integrationConfig>,private field:PlumeModel['concentrationAt'],private dt:number,seed:number){this.channels=Array.from({length:4},()=>new LinearInletChannel(c.localInletSampling!));this.noise=new SeededRandom(seed)}
 advance(to:number,poseAt:(t:number)=>MotionPose){
  const c=this.c,p=c.localInletSampling!,radius=p.opposingInletSpacingMetres/(2*c.domainMeters)
  while(this.tick*this.dt<=to){
   const t=this.tick*this.dt,pose=poseAt(t)
   const points=[0,-Math.PI/2,Math.PI,Math.PI/2].map(a=>({x:pose.position.x+radius*Math.cos(pose.heading+a),y:pose.position.y+radius*Math.sin(pose.heading+a)}))
   const values=points.map(x=>this.field(x,t)),filtered=values.map((v,j)=>this.channels[j]!.update(t,v))
   if(this.tick%Math.round(1/this.dt)===0)this.readout=filtered.map(v=>Math.max(0,Math.min(c.sensorSaturation,v+c.sensorNoise*this.noise.normal())))
   this.trace.push([t,pose.position.x,pose.position.y,pose.heading,...points.flatMap(x=>[x.x,x.y]),...values,...filtered,...this.readout]);this.tick++
  }
 }
}
