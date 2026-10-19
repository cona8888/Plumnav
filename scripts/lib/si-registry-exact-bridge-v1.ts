import {spawn} from 'node:child_process'
import {createInterface} from 'node:readline'
import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'

type Pending={resolve:(value:any)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>;context:Record<string,unknown>}
const digest=(file:string)=>createHash('sha256').update(readFileSync(file)).digest('hex')

/** Artificial-registry prototype, not connected to any mission runner. */
export class RegistryExactBridgeV1 {
  private readonly child
  private next=0
  private pending=new Map<number,Pending>()
  private readonly closed:Promise<void>
  private ending=false
  readonly registrySha256:string
  constructor(registryPath:string,expectedRegistrySha256:string,expectedBridgeSha256:string){
    const file='scripts/si-registry-exact-bridge-v1.py'
    if(digest(file)!==expectedBridgeSha256)throw Error('Registry bridge source mismatch')
    this.registrySha256=digest(registryPath)
    if(this.registrySha256!==expectedRegistrySha256)throw Error('Registry file mismatch')
    if(!process.env.PYTHON)throw Error('Explicit Python runtime required')
    this.child=spawn(process.env.PYTHON,['-u',file,'--registry',registryPath,'--registry-sha256',expectedRegistrySha256],{stdio:['pipe','pipe','inherit'],env:{...process.env,PYTHONDONTWRITEBYTECODE:'1',OPENBLAS_NUM_THREADS:'1',OMP_NUM_THREADS:'1',MKL_NUM_THREADS:'1'}})
    const rejectAll=(error:Error)=>{for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(error)}this.pending.clear()}
    this.child.stdin.on('error',error=>rejectAll(error))
    createInterface({input:this.child.stdout}).on('line',line=>{
      try{
        const r=JSON.parse(line),p=this.pending.get(r.id)
        if(!p)throw Error('Unexpected registry RPC identity')
        if(r.ok===true){
          const value=r.result
          if(value?.version!=='readout-registry-exact-v1'||value.registrySha256!==this.registrySha256||value.exactPoseOnly!==true||value.arms?.length!==1||value.arms[0].poseRadiusMetres!==0)throw Error('Invalid registry RPC declaration')
          for(const [key,expected] of Object.entries(p.context))if(value.context?.[key]!==expected)throw Error('Registry RPC context mismatch')
          clearTimeout(p.timer);this.pending.delete(r.id);p.resolve(value)
        }else if(r.ok===false&&typeof r.error==='string'){
          clearTimeout(p.timer);this.pending.delete(r.id);p.reject(Error(r.error))
        }else throw Error('Malformed registry RPC response')
      }catch(error){rejectAll(error instanceof Error?error:Error(String(error)));this.child.kill()}
    })
    this.closed=new Promise((resolve,reject)=>{
      this.child.on('error',error=>{rejectAll(error);reject(error)})
      this.child.on('exit',code=>{const error=Error(`Registry verifier exited ${code}`);rejectAll(error);code===0?resolve():reject(error)})
    })
    this.closed.catch(()=>{})
  }
  request(data:Record<string,unknown>){
    if(this.ending||this.child.exitCode!==null)return Promise.reject(Error('Registry verifier is closed'))
    const id=this.next++,context=Object.fromEntries(['worldKey','arm','field','reportingReplicate'].map(key=>[key,data[key]]))
    return new Promise<any>((resolve,reject)=>{
      let payload:string
      try{payload=JSON.stringify({...data,id})+'\n'}catch(error){reject(error);return}
      const timer=setTimeout(()=>{this.pending.delete(id);reject(Error('Registry RPC timeout'));this.child.kill()},30000)
      this.pending.set(id,{resolve,reject,timer,context})
      this.child.stdin.write(payload,error=>{if(error){clearTimeout(timer);this.pending.delete(id);reject(error)}})
    })
  }
  async close(){this.ending=true;this.child.stdin.end();await this.closed}
}
