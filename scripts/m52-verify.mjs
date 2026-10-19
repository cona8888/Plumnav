import {readFileSync,statSync} from 'node:fs'
import {resolve,relative,isAbsolute} from 'node:path'
import {createHash} from 'node:crypto'
import assert from 'node:assert/strict'

const root=resolve(process.argv[2]??'research/results/m52-openfoam-cloudshell-smoke-v1')
const read=p=>readFileSync(resolve(root,p),'utf8')
const hashes=read('SHA256SUMS').trim().split('\n')
const seen=new Set()
for(const line of hashes){
  const m=line.match(/^([a-f0-9]{64})  (.+)$/);assert.ok(m,'Invalid checksum row')
  const path=resolve(root,m[2]),rel=relative(root,path)
  assert.ok(rel&&!rel.startsWith('..')&&!isAbsolute(rel),'Path escapes archive')
  assert.ok(!seen.has(rel),'Duplicate path');seen.add(rel)
  assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'),m[1],rel)
}
for(const file of ['COMPLETE.txt','package-versions.txt','foamRun.log','checkMesh.log',
  'blockMesh.log','configure.log','foamRun-help.log','blockMesh-help.log',
  'pitzDailySteady/5/U','pitzDailySteady/5/p']){
  assert.ok(seen.has(file),`Missing hashed artifact: ${file}`)
  assert.ok(statSync(resolve(root,file)).size>0)
}
assert.match(read('COMPLETE.txt'),/Compatibility only/)
assert.match(read('package-versions.txt'),/^openfoam14\s+20260724$/m)
assert.match(read('checkMesh.log'),/Mesh OK/)
const log=read('foamRun.log')
assert.deepEqual([...log.matchAll(/^Time = (\d+)(?:s)?$/gm)].map(m=>Number(m[1])),[1,2,3,4,5])
assert.match(log,/^End$/m)
assert.doesNotMatch(log,/FOAM FATAL|Segmentation fault|^\s*Floating point exception(?: \(core dumped\))?$|\bnan\b/im)
for(const field of ['U','p'])assert.doesNotMatch(read(`pitzDailySteady/5/${field}`),/\b(?:nan|inf|infinity)\b/i)
console.log(JSON.stringify({verified:true,iterations:5,files:seen.size,
  scope:'Runtime compatibility only; unconverged flow, not methane/GSL validation'},null,2))
