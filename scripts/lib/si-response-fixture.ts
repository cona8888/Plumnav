import {spawn} from 'node:child_process'
import {createInterface} from 'node:readline'
import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {resolve} from 'node:path'
import type {VerifierBridge} from './si-integration'
import {runResponseIntegration} from './si-response-integration'

export class ResponseVerifierBridge implements Pick<VerifierBridge,'request'|'close'> {
 readonly fixtureSha256:string
 private readonly child
 private next=0
 private pending=new Map<number,{resolve:(value:any)=>void;reject:(error:Error)=>void}>()
 private readonly closed:Promise<void>
 constructor(){
  const file=process.env.REPORTING_FIXTURE_FILE,expected=process.env.REPORTING_FIXTURE_SHA256
  if(!file||!expected)throw Error('Explicit reporting fixture and hash required')
  this.fixtureSha256=createHash('sha256').update(readFileSync(file)).digest('hex')
  if(this.fixtureSha256!==expected)throw Error('Reporting fixture checksum mismatch')
  this.child=spawn(process.env.PYTHON??'python',['-u','scripts/si-response-integration-bridge.py'],{stdio:['pipe','pipe','inherit'],env:{...process.env,REPORTING_FIXTURE_FILE:resolve(file),OPENBLAS_NUM_THREADS:'1',OMP_NUM_THREADS:'1'}})
  const rejectAll=(error:Error)=>{for(const p of this.pending.values())p.reject(error);this.pending.clear()}
  createInterface({input:this.child.stdout}).on('line',line=>{
   try{const r=JSON.parse(line),p=this.pending.get(r.id);if(!p)throw Error('Unexpected verifier RPC');this.pending.delete(r.id);r.ok?p.resolve(r.result):p.reject(Error(r.error))}
   catch(e){rejectAll(e instanceof Error?e:Error(String(e)));this.child.kill()}
  })
  this.closed=new Promise((resolve,reject)=>{
   this.child.on('error',error=>{rejectAll(error);reject(error)})
   this.child.on('exit',code=>{const error=Error(`Fixture verifier exited ${code}`);rejectAll(error);code===0?resolve():reject(error)})
  })
  // Preserve rejection for close(), but avoid an unhandled rejection before it.
  this.closed.catch(()=>{})
 }
 request(data:object){
  if(this.child.exitCode!==null) return Promise.reject(Error('Fixture verifier is closed'))
  const id=this.next++
  return new Promise<any>((resolve,reject)=>{this.pending.set(id,{resolve,reject});this.child.stdin.write(JSON.stringify({...data,id})+'\n',error=>{if(error){this.pending.delete(id);reject(error)}})})
 }
 async close(){this.child.stdin.end();await this.closed}
}

export async function runResponseFixtureIntegration(spec:Parameters<typeof runResponseIntegration>[0],bridge:ResponseVerifierBridge){
 // The frozen routine consumes only request(); its nominal class type includes
 // private process fields. This boundary does not modify or override that routine.
 const record=await runResponseIntegration(spec,bridge as unknown as VerifierBridge)
 return {...record,reportingFixture:{version:'fixed-reporting-fixture-v1',sha256:bridge.fixtureSha256,reportingReplicate:600000+spec.replicate}}
}
