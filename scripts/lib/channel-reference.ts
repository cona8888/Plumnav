/** Independent event-split RK4 integration of delayed first-order response and
 * its cumulative integral. Known inlet history only; not an inverse estimator.
 * Does not import LocalInletChannel or its analytical segment integrator. */
export type ChannelInput={time:number;value:number}
export function channelReference(input:ChannelInput[],settings:{delay:number;rise:number;recovery:number;average:number},step:number){
 if(!input.length||step<=0||settings.average<=0)throw Error('Invalid reference inputs')
 const events=input.map(s=>({time:s.time+settings.delay,value:s.value})),outputs:number[]=[],cumulative=new Map<number,number>()
 let time=0,state=0,integral=0,target=0,event=0
 function advance(end:number){while(time<end-1e-12){const h=Math.min(step,end-time),tau=target>=state?settings.rise:settings.recovery
  const k1=(target-state)/tau,y2=state+h*k1/2,k2=(target-y2)/tau,y3=state+h*k2/2,k3=(target-y3)/tau,y4=state+h*k3,k4=(target-y4)/tau
  integral+=h*(state+2*y2+2*y3+y4)/6;state+=h*(k1+2*k2+2*k3+k4)/6;time+=h
 }time=end}
 // Add averaging cutoffs explicitly rather than interpolate cumulative area.
 const query=[...new Set(input.flatMap(s=>[s.time,...(s.time>=settings.average?[s.time-settings.average]:[])]))].sort((a,b)=>a-b)
 for(const end of query){while(event<events.length&&events[event]!.time<=end){advance(events[event]!.time);target=events[event++]!.value}advance(end);cumulative.set(end,integral)}
 for(const s of input)outputs.push((cumulative.get(s.time)!-(s.time>=settings.average?cumulative.get(s.time-settings.average)!:0))/settings.average)
 return outputs
}
