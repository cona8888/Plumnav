import {spawn} from 'node:child_process'
import {createInterface} from 'node:readline'
import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import type {VerifierBridge} from './si-integration'

/** Separately scoped exact-pose development bridge; never substitutes fake success. */
export class ReadoutExactBridge implements Pick<VerifierBridge,'request'|'close'> {
  private readonly child
  private next=0
  private pending=new Map<number,{resolve:(value:any)=>void;reject:(error:Error)=>void}>()
  private readonly closed:Promise<void>
  readonly sourceSha256:string
  constructor(expectedSha256:string){
    const file='scripts/si-readout-exact-bridge.py'
    this.sourceSha256=createHash('sha256').update(readFileSync(file)).digest('hex')
    if(this.sourceSha256!==expectedSha256)throw Error('Exact bridge source mismatch')
    if(!process.env.PYTHON)throw Error('Explicit Python runtime required')
    this.child=spawn(process.env.PYTHON,['-u',file],{stdio:['pipe','pipe','inherit'],env:{...process.env,OPENBLAS_NUM_THREADS:'1',OMP_NUM_THREADS:'1',MKL_NUM_THREADS:'1'}})
    const rejectAll=(error:Error)=>{for(const p of this.pending.values())p.reject(error);this.pending.clear()}
    createInterface({input:this.child.stdout}).on('line',line=>{
      try{const r=JSON.parse(line),p=this.pending.get(r.id);if(!p)throw Error('Unexpected exact verifier RPC');this.pending.delete(r.id);r.ok?p.resolve(r.result):p.reject(Error(r.error))}
      catch(e){rejectAll(e instanceof Error?e:Error(String(e)));this.child.kill()}
    })
    this.closed=new Promise((resolve,reject)=>{
      this.child.on('error',error=>{rejectAll(error);reject(error)})
      this.child.on('exit',code=>{const error=Error(`Exact verifier exited ${code}`);rejectAll(error);code===0?resolve():reject(error)})
    })
    this.closed.catch(()=>{})
  }
  request(data:object){
    if(this.child.exitCode!==null)return Promise.reject(Error('Exact verifier is closed'))
    const id=this.next++
    return new Promise<any>((resolve,reject)=>{this.pending.set(id,{resolve,reject});this.child.stdin.write(JSON.stringify({...data,id})+'\n',error=>{if(error){this.pending.delete(id);reject(error)}})})
  }
  async close(){this.child.stdin.end();await this.closed}
}
