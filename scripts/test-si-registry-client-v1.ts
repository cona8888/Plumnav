import {readFileSync,writeFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {isDeepStrictEqual} from 'node:util'
import {RegistryExactBridgeV1} from './lib/si-registry-exact-bridge-v1'
const args=process.argv.slice(2)
const get=(name:string)=>{const i=args.indexOf(name);if(i<0||!args[i+1])throw Error('Missing '+name);return args[i+1]}
const input=get('--input'),output=get('--output')
const data=JSON.parse(readFileSync(input,'utf8'))
const sha=createHash('sha256').update(readFileSync('scripts/si-registry-exact-bridge-v1.py')).digest('hex')
const start=performance.now()
let wrongPins=0,comparisons=0
for(const [registryPin,sourcePin] of [['0'.repeat(64),sha],[data.registrySha256,'0'.repeat(64)]]){
  try{new RegistryExactBridgeV1(data.registryPath,registryPin,sourcePin);throw Error('Wrong pin accepted')}
  catch(error){if(String(error).includes('Wrong pin accepted'))throw error;wrongPins++}
}
const bridge=new RegistryExactBridgeV1(data.registryPath,data.registrySha256,sha)
try{
  for(const fixture of data.fixtures)for(const world of data.worlds)for(const arm of ['RW','GW','RL','GL','NS'])for(const field of ['si-continuous','si-pulse','blank']){
    const observation=structuredClone(fixture.observation)
    const request={operation:'verify',...world,arm,field,...observation}
    const before=structuredClone(request),response=await bridge.request(request)
    if(!isDeepStrictEqual(response.arms,fixture.expectedArms)||!isDeepStrictEqual(request,before))throw Error('Client decision/observation mismatch')
    comparisons++
  }
  const request={operation:'verify',...data.worlds[0],arm:'GL',field:'si-continuous',...data.fixtures[0].observation}
  let rejected=false
  try{await bridge.request({...request,reportingReplicate:1600001})}catch{rejected=true}
  if(!rejected)throw Error('Mismatched identity accepted')
  if(!isDeepStrictEqual((await bridge.request(request)).arms,data.fixtures[0].expectedArms))throw Error('Recovery failed')
  await bridge.close()
  let afterClose=false
  try{await bridge.request(request)}catch{afterClose=true}
  if(!afterClose)throw Error('Closed client accepted request')
  const result={passed:true,createdAt:new Date().toISOString(),elapsedSeconds:(performance.now()-start)/1000,comparisons,wrongPins,mismatchedIdentityRejected:true,liveRecovery:true,closedRequestRejected:true,newMissions:0}
  writeFileSync(output,JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(result))
}catch(error){try{await bridge.close()}catch{};throw error}
