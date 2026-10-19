/** Pointwise half-space transport witness. Not a calibrated outdoor CFD model.
 * Gaussian finite-volume release with a reflecting z=0 plane, constant
 * horizontal velocity and constant isotropic diffusivity. SI mass units.
 * Robot queries may stay on one horizontal plane while the kernel spreads in 3-D.
 */
export type Point3 = {x:number;y:number;z:number}
export type HalfspaceSettings = {
  source:Point3; wind:{x:number;y:number}; diffusivity:number; sigma:number
  rateKgPerSecond:number; panelSeconds:number
  pulse?:{periodSeconds:number;phaseSeconds:number}
}
const nodes=[-0.8611363115940526,-0.3399810435848563,0.3399810435848563,0.8611363115940526]
const weights=[0.34785484513745385,0.6521451548625461,0.6521451548625461,0.34785484513745385]
type Component={x:number;y:number;variance:number;amplitude:number}
export class HalfspaceTransport {
  readonly settings:HalfspaceSettings
  private lastTime=NaN
  private components:Component[]=[]
  private preparedMass=0
  constructor(settings:HalfspaceSettings) {
    const s=settings
    if(![s.source.x,s.source.y,s.source.z,s.wind.x,s.wind.y,s.diffusivity,s.sigma,s.rateKgPerSecond,s.panelSeconds].every(Number.isFinite)||
      s.source.z<0||s.diffusivity<0||s.sigma<=0||s.rateKgPerSecond<0||s.panelSeconds<=0||
      (s.pulse&&(!Number.isFinite(s.pulse.periodSeconds)||s.pulse.periodSeconds<=0||!Number.isFinite(s.pulse.phaseSeconds))))throw new RangeError('Invalid half-space transport')
    this.settings=structuredClone(settings)
  }
  rateAt(time:number) {
    if(!Number.isFinite(time))throw new RangeError('Invalid emission time')
    if(time<0)return 0
    const p=this.settings.pulse
    if(!p)return this.settings.rateKgPerSecond
    const phase=((time+p.phaseSeconds)%p.periodSeconds+p.periodSeconds)%p.periodSeconds
    return phase<p.periodSeconds/2?this.settings.rateKgPerSecond:0
  }
  private intervals(time:number,visit:(lo:number,hi:number,rate:number)=>void) {
    if(!Number.isFinite(time)||time<0)throw new RangeError('Invalid transport time')
    for(let lo=0;lo<time;) {
      let hi=Math.min(time,lo+this.settings.panelSeconds)
      const p=this.settings.pulse
      if(p) {
        const half=p.periodSeconds/2
        const edge=(Math.floor((lo+p.phaseSeconds+1e-10)/half)+1)*half-p.phaseSeconds
        if(edge>lo+1e-10)hi=Math.min(hi,edge)
      }
      if(hi<=lo)throw new Error('Nonadvancing quadrature')
      visit(lo,hi,this.rateAt((lo+hi)/2));lo=hi
    }
  }
  private component(age:number,mass:number):Component {
    const s=this.settings,v=s.sigma**2+2*s.diffusivity*age
    return {x:s.source.x+s.wind.x*age,y:s.source.y+s.wind.y*age,variance:v,
      amplitude:mass/(2*Math.PI*v)**1.5}
  }
  pulseAt(point:Point3,age:number,mass:number) {
    if(!Number.isFinite(age)||age<0||!Number.isFinite(mass)||mass<0)throw new RangeError('Invalid pulse')
    return this.sum(point,[this.component(age,mass)])
  }
  private prepare(time:number) {
    if(time===this.lastTime)return
    const components:Component[]=[];let mass=0
    this.intervals(time,(lo,hi,rate)=>{
      if(rate===0)return
      mass+=rate*(hi-lo)
      const middle=(lo+hi)/2,half=(hi-lo)/2
      for(let k=0;k<4;k++)components.push(this.component(time-middle-half*nodes[k]!,rate*half*weights[k]!))
    })
    this.components=components;this.preparedMass=mass;this.lastTime=time
  }
  private sum(p:Point3,components:readonly Component[]) {
    if(![p.x,p.y,p.z].every(Number.isFinite)||p.z<0)throw new RangeError('Point must lie above reflecting ground')
    let concentration=0,gx=0,gy=0,gz=0
    const h=this.settings.source.z
    for(const c of components) {
      const dx=p.x-c.x,dy=p.y-c.y,z1=p.z-h,z2=p.z+h,v=c.variance
      const horizontal=c.amplitude*Math.exp(-(dx*dx+dy*dy)/(2*v))
      const a=Math.exp(-z1*z1/(2*v)),b=Math.exp(-z2*z2/(2*v))
      const value=horizontal*(a+b)
      concentration+=value;gx-=dx/v*value;gy-=dy/v*value;gz-=horizontal*(z1*a+z2*b)/v
    }
    return {concentration,gradient:{x:gx,y:gy,z:gz}}
  }
  evaluate(point:Point3,time:number) { this.prepare(time);return this.sum(point,this.components) }
  integratedMassAt(time:number) { this.prepare(time);return this.preparedMass }
}
