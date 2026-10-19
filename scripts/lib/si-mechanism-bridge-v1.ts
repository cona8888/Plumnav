import {spawn} from 'node:child_process'
import {createInterface} from 'node:readline'
import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {isDeepStrictEqual} from 'node:util'

/** Binding sits outside the source-blind controller. No field values are added. */
export class MechanismBridgeV1 {
  private readonly child
  private readonly closed:Promise<void>
  private pending=new Map<number,{resolve:(v:any)=>void;reject:(e:Error)=>void;timer:ReturnType<typeof setTimeout>}>()
  private next=0
  private ending=false
  calls=0
  constructor(private manifestSha256:string,manifestPath:string,private context:{caseId:string;worldKey:string;arm:string;field:string;reportingReplicate:number},serviceSha:string){
    const sha=(path:string)=>createHash('sha256').update(readFileSync(path)).digest('hex')
    const service='scripts/si-mechanism-bridge-v1.py'
    if(sha(service)!==serviceSha||sha(manifestPath)!==manifestSha256)throw Error('Bridge/manifest pin mismatch')
    if(!process.env.PYTHON)throw Error('Explicit Python runtime required')
    this.context=Object.freeze({...context})
    this.child=spawn(process.env.PYTHON,['-u',service,'--manifest',manifestPath,'--sha256',manifestSha256],{
      stdio:['pipe','pipe','inherit'],env:{...process.env,PYTHONDONTWRITEBYTECODE:'1',OMP_NUM_THREADS:'1',OPENBLAS_NUM_THREADS:'1',MKL_NUM_THREADS:'1'}})
    const rejectAll=(e:Error)=>{for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(e)}this.pending.clear()}
    this.child.stdin.on('error',rejectAll)
    createInterface({input:this.child.stdout}).on('line',line=>{
      try{
        const r=JSON.parse(line),p=this.pending.get(r.id)
        if(!p)throw Error('Unexpected RPC identity')
        if(r.ok===false&&typeof r.error==='string'){clearTimeout(p.timer);this.pending.delete(r.id);p.reject(Error(r.error));return}
        const v=r.result
        if(r.ok!==true||v?.version!=='mechanism-exact-v1'||v.manifestSha256!==this.manifestSha256||v.exactPoseOnly!==true||!isDeepStrictEqual(v.context,this.context)||v.arms?.length!==1||v.arms[0].poseRadiusMetres!==0)throw Error('Malformed/unbound verifier response')
        clearTimeout(p.timer);this.pending.delete(r.id);p.resolve(v)
      }catch(e){rejectAll(e instanceof Error?e:Error(String(e)));this.child.kill()}
    })
    this.closed=new Promise((resolve,reject)=>{
      this.child.on('error',e=>{rejectAll(e);reject(e)})
      this.child.on('exit',code=>{const e=Error('Verifier exit '+code);rejectAll(e);code===0?resolve():reject(e)})
    });this.closed.catch(()=>{})
  }
  request(data:object){
    if(this.ending||this.child.exitCode!==null)return Promise.reject(Error('Bridge closed'))
    const q=data as Record<string,unknown>
    if(Object.keys(q).sort().join(',')!=='motionContract,operation,reportingReplicate,visits'||q.operation!=='verify'||q.reportingReplicate!==this.context.reportingReplicate)return Promise.reject(Error('Undeclared mission RPC keys/identity'))
    const id=this.next++
    return new Promise<any>((resolve,reject)=>{
      let payload:string
      try{payload=JSON.stringify({...q,id,caseId:this.context.caseId})+'\n'}catch(e){reject(e);return}
      const timer=setTimeout(()=>{this.pending.delete(id);reject(Error('Verifier timeout'));this.child.kill()},30000)
      this.pending.set(id,{resolve,reject,timer});this.calls++
      this.child.stdin.write(payload,e=>{if(e){clearTimeout(timer);this.pending.delete(id);reject(e)}})
    })
  }
  async close(){this.ending=true;this.child.stdin.end();await this.closed}
}
