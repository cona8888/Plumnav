import type {AlgorithmDecision,Vec2} from '../../src/sim/types'

export type MotionPose={position:Vec2;heading:number;distance:number}
export type MotionSegment={version:'event-exact-turn-move-v2';antipodalTie:boolean;angularTolerance:number;start:number;duration:number;initial:MotionPose;angularVelocity:number;turnSeconds:number;moveSeconds:number;speed:number;direction:Vec2;held:boolean;wallLimited:boolean}

export const MAX_ABS_HEADING=1024
/** Representation-level budget, not actuator precision or a global stability claim.
 * Keep the old libm principal-angle path outside the tiny antipodal band.
 */
export function resolvedTurn(desired:number,heading:number){
 if(!Number.isFinite(desired)||!Number.isFinite(heading)||Math.abs(heading)>MAX_ABS_HEADING)throw Error('Heading outside versioned turn envelope')
 const raw=desired-heading,principal=Math.atan2(Math.sin(raw),Math.cos(raw))
 const tolerance=128*Number.EPSILON*(1+Math.abs(heading)+Math.abs(desired))
 const antipodalTie=Math.PI-Math.abs(principal)<=tolerance
 return {delta:antipodalTie?Math.PI:principal,antipodalTie,tolerance}
}

/** Flat empty square only. Controller commands are held for this full interval.
 * Rotate in place, translate in remaining time, and stop at first wall contact.
 * No solver timestep participates in the end-pose calculation.
 */
export function makeMotionSegment(initial:MotionPose,decision:AlgorithmDecision,start:number,duration:number,maxSpeed:number,turnRate:number,clearance:number,held=false):MotionSegment{
 if(![initial.position.x,initial.position.y,initial.heading,initial.distance,start,duration,maxSpeed,turnRate,clearance,decision.direction.x,decision.direction.y,decision.speedScale??1].every(Number.isFinite)||duration<=0||maxSpeed<0||turnRate<=0||clearance<0||clearance>=.5||initial.distance<0||start<0)throw Error('Invalid event motion inputs')
 if(Math.abs(initial.heading)>MAX_ABS_HEADING)throw Error('Heading outside versioned turn envelope')
 if(initial.position.x<clearance-1e-12||initial.position.x>1-clearance+1e-12||initial.position.y<clearance-1e-12||initial.position.y>1-clearance+1e-12)throw Error('Initial pose outside robot-safe square')
 const s:MotionSegment={version:'event-exact-turn-move-v2',antipodalTie:false,angularTolerance:0,start,duration,initial:structuredClone(initial),angularVelocity:0,turnSeconds:0,moveSeconds:0,speed:0,direction:{x:0,y:0},held,wallLimited:false}
 const length=Math.hypot(decision.direction.x,decision.direction.y)
 if(held||length<=1e-9)return s
 const desired=Math.atan2(decision.direction.y,decision.direction.x),resolved=resolvedTurn(desired,initial.heading),delta=resolved.delta
 s.antipodalTie=resolved.antipodalTie;s.angularTolerance=resolved.tolerance
 s.angularVelocity=Math.sign(delta)*turnRate;s.turnSeconds=Math.min(duration,Math.abs(delta)/turnRate)
 s.speed=maxSpeed*Math.max(0,Math.min(1,decision.speedScale??1))
 const heading=initial.heading+s.angularVelocity*s.turnSeconds
 s.direction={x:Math.cos(heading),y:Math.sin(heading)}
 if(s.turnSeconds>=duration||s.speed===0)return s
 const available=duration-s.turnSeconds
 let untilWall=Infinity
 for(const key of ['x','y'] as const){const velocity=s.speed*s.direction[key];if(velocity!==0){const boundary=velocity>0?1-clearance:clearance;untilWall=Math.min(untilWall,Math.max(0,(boundary-initial.position[key])/velocity))}}
 s.moveSeconds=Math.min(available,untilWall);s.wallLimited=untilWall<available;return s
}

export function sampleMotion(s:MotionSegment,time:number):MotionPose{
 const age=time-s.start
 if(!Number.isFinite(time)||age<0||age>s.duration)throw Error('Outside causal motion interval')
 const rotating=Math.min(age,s.turnSeconds),moving=Math.min(s.moveSeconds,Math.max(0,age-s.turnSeconds)),travel=s.speed*moving
 return {position:{x:s.initial.position.x+s.direction.x*travel,y:s.initial.position.y+s.direction.y*travel},heading:s.initial.heading+s.angularVelocity*rotating,distance:s.initial.distance+travel}
}
