import type {Point} from './m41-spatial-check'
export type Puff={released:number;mass:number;source:Point;sigma:number}
export type Transport={wind:Point;diffusivity:number}
/** Infinite-plane 2-D Gaussian packet: exact constant-wind advection-diffusion
 * of a Gaussian initial condition. Concentration has mass/area units, not ppm. */
export function gaussianPacket(p:Point,t:number,puff:Puff,transport:Transport) {
  if(![p.x,p.y,t,puff.released,puff.mass,puff.source.x,puff.source.y,puff.sigma,
    transport.wind.x,transport.wind.y,transport.diffusivity].every(Number.isFinite)||
    puff.mass<0||puff.sigma<=0||transport.diffusivity<0)throw new RangeError('Invalid transport inputs')
  const age=t-puff.released
  if(age<0)return {concentration:0,gradient:{x:0,y:0}}
  const variance=puff.sigma**2+2*transport.diffusivity*age
  const dx=p.x-puff.source.x-transport.wind.x*age,dy=p.y-puff.source.y-transport.wind.y*age
  const concentration=puff.mass/(2*Math.PI*variance)*Math.exp(-(dx*dx+dy*dy)/(2*variance))
  return {concentration,gradient:{x:-dx/variance*concentration,y:-dy/variance*concentration}}
}
export type PlumeCase='steady-release'|'interrupted-release'|'absent'
export function makeTransportField(kind:PlumeCase,transport:Transport,releaseStep=1,releaseEnd=30) {
  if(!Number.isFinite(releaseStep)||releaseStep<=0)throw new RangeError('Invalid release step')
  // Prescribed finite pulse source from -60 through +30 s. Midpoint pulses
  // approximate a continuous rate; release-step refinement is checked separately.
  const puffs:Puff[]=[]
  if(!Number.isFinite(releaseEnd)||releaseEnd<=-60)throw new RangeError('Invalid release horizon')
  for(let s=-60;s<releaseEnd-1e-9;s+=releaseStep){
    const t=s+releaseStep/2
    const rate=kind==='absent'?0:kind==='interrupted-release'&&t>=-5?0:.03
    puffs.push({released:t,mass:rate*releaseStep,source:{x:0,y:0},sigma:.05})
  }
  gaussianPacket({x:0,y:0},0,puffs[0]!,transport) // validate fixed parameters once
  let lastTime=NaN,prepared:{x:number;y:number;variance:number;amplitude:number}[]=[]
  const evaluate=(p:Point,t:number)=>{
    if(![p.x,p.y,t].every(Number.isFinite))throw new RangeError('Invalid query')
    if(t!==lastTime){lastTime=t;prepared=puffs.filter(f=>f.released<=t&&f.mass>0).map(f=>{
      const age=t-f.released,variance=f.sigma**2+2*transport.diffusivity*age
      return {x:f.source.x+transport.wind.x*age,y:f.source.y+transport.wind.y*age,
        variance,amplitude:f.mass/(2*Math.PI*variance)}
    })}
    let concentration=0,gx=0,gy=0
    for(const f of prepared){const dx=p.x-f.x,dy=p.y-f.y,
      value=f.amplitude*Math.exp(-(dx*dx+dy*dy)/(2*f.variance))
      concentration+=value;gx-=dx/f.variance*value;gy-=dy/f.variance*value}
    return {concentration,gradient:{x:gx,y:gy}}
  }
  return {evaluate,puffs,transport,kind,releaseStep}
}
