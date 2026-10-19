import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { runM28, M28_DESIGN } from './lib/m28-continuous-feasible'
export const M28_ROOT = 'research/evidence/m28_continuous_feasible_2026-09-09'
const hash = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
if (process.env.M28_RUN === '1') {
  const paths = ['scripts/lib/m21-direction.ts','scripts/lib/m21-direction-study.ts','scripts/lib/m22-recovery.ts','scripts/lib/m23-rotation-transfer.ts','scripts/lib/m24-time-aware.ts','scripts/lib/m26-action-horizon.ts','scripts/lib/m28-continuous-feasible.ts','scripts/m28-continuous-feasible.ts','scripts/m28-continuous-feasible.test.ts','research/protocols/m28_continuous_feasible_protocol.md','src/sim/config.ts','src/sim/scenarios.ts','src/sim/controllerObservationModel.ts','src/sim/environment.ts','src/sim/math.ts','src/sim/engine.ts','src/sim/quadSniff.ts','src/sim/terrain.ts','src/sim/types.ts','src/sim/plume.ts','src/sim/rng.ts']
  const sources = await Promise.all(paths.map(async (path) => ({ path, data: await readFile(path) }))); await mkdir(M28_ROOT); const sourceInventory = []
  for (const s of sources) { const target = join(M28_ROOT,'source-snapshot',s.path); await mkdir(dirname(target),{recursive:true}); await writeFile(target,s.data,{flag:'wx'}); sourceInventory.push({path:s.path,bytes:s.data.length,sha256:hash(s.data)}) }
  const write = async (name:string,value:unknown) => { const data=Buffer.from(JSON.stringify(value)+'\n'); await writeFile(join(M28_ROOT,name),data,{flag:'wx'}); return {path:name,bytes:data.length,sha256:hash(data)} }
  const inventory=[await write('design.json',{...M28_DESIGN,sourceInventory})], start=performance.now(), result=runM28(), elapsedSeconds=(performance.now()-start)/1000
  inventory.push(await write('results.json',result),await write('runtime.json',{elapsedSeconds,peakRssBytes:process.resourceUsage().maxRSS*1024,node:process.version,arch:process.arch})); await write('checksums.json',{complete:true,inventory})
  console.log(JSON.stringify({complete:true,episodes:result.episodes,actions:result.actions,advances:result.advancesToReacquisitionTest,failures:{safety:result.failures.safety.length,distance:result.failures.distance.length,acceptance:result.failures.acceptance.length,gainCells:result.failures.gainCells.length,slowFollow:result.failures.slowFollow.length,overallGain:result.failures.overallGain},elapsedSeconds}))
}
