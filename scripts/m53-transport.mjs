import {mkdirSync,writeFileSync,readFileSync,existsSync,cpSync,readdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';

export const protocol={version:'m53-v1',L:1,width:0.1,T:0.2,mean:1,amplitude:0.5,
  scheme:'Euler / Gauss linear / Gauss linear corrected',
  gates:{massAbsolute:1e-10,discreteRms:1e-8,blankAbsolute:1e-12,spatialOrderMin:1.8,temporalOrderMin:0.85}};
export function cases(){
  const rows=[];
  for(const [kind,u,D] of [['diffusion',0,0.01],['advection',0.2,0],['combined',0.2,0.01]]){
    for(const n of [20,40,80]) rows.push({id:`${kind}-space-${n}`,kind,series:'space',n,u,D,dt:0.0001});
    for(const dt of [0.05,0.025,0.0125,0.00625]) rows.push({id:`${kind}-time-${dt}`,kind,series:'time',n:160,u,D,dt});
  }
  rows.push({id:'blank',kind:'blank',series:'control',n:40,u:0.2,D:0.01,dt:0.001});
  return rows;
}
export function expected(c,x,mode='pde',t=protocol.T){
  if(c.kind==='blank') return 0;
  const k=2*Math.PI/protocol.L,h=protocol.L/c.n;
  const amplitude=protocol.amplitude*Math.sin(k*h/2)/(k*h/2); // Cell average, not point value.
  let decay=c.D*k*k,frequency=c.u*k,mag,phase;
  if(mode!=='pde') {decay=c.D*4*Math.sin(k*h/2)**2/h**2;frequency=c.u*Math.sin(k*h)/h;}
  if(mode==='discrete'){
    const steps=Math.round(t/c.dt),a=1+c.dt*decay,b=c.dt*frequency;
    mag=Math.exp(-steps*Math.log(Math.hypot(a,b)));phase=-steps*Math.atan2(b,a);
  }else{mag=Math.exp(-decay*t);phase=-frequency*t;}
  return protocol.mean+amplitude*mag*Math.cos(k*x+phase);
}
const header=(object,cls='dictionary')=>`FoamFile { format ascii; class ${cls}; object ${object}; }\n`;
const boundary='boundaryField { left { type cyclic; } right { type cyclic; } sides { type zeroGradient; } }\n';
export function generate(root){
  root=resolve(root);assert.ok(!existsSync(root),'Refuse to overwrite an existing case archive');mkdirSync(root,{recursive:true});
  const hashes={};
  const put=(name,text)=>{const p=join(root,name);mkdirSync(resolve(p,'..'),{recursive:true});writeFileSync(p,text);hashes[name]=createHash('sha256').update(text).digest('hex');};
  put('protocol.json',JSON.stringify({...protocol,cases:cases()},null,2)+'\n');
  for(const c of cases()){
    const p=`cases/${c.id}/`;
    put(p+'system/blockMeshDict',header('blockMeshDict')+`scale 1;\nvertices ((0 0 0)(1 0 0)(1 .1 0)(0 .1 0)(0 0 .1)(1 0 .1)(1 .1 .1)(0 .1 .1));\nblocks (hex (0 1 2 3 4 5 6 7) (${c.n} 1 1) simpleGrading (1 1 1));\nedges ();\nboundary (left { type cyclic; neighbourPatch right; faces ((0 4 7 3)); } right { type cyclic; neighbourPatch left; faces ((1 2 6 5)); } sides { type wall; faces ((0 1 5 4)(3 7 6 2)(0 3 2 1)(4 5 6 7)); });\nmergePatchPairs ();\n`);
    put(p+'system/controlDict',header('controlDict')+`application m53Transport; startFrom startTime; startTime 0; stopAt endTime; endTime ${protocol.T}; deltaT ${c.dt}; writeControl timeStep; writeInterval ${Math.round(protocol.T/c.dt)}; writeFormat ascii; writePrecision 17; timeFormat general; timePrecision 12; runTimeModifiable false;\n`);
    put(p+'system/fvSchemes',header('fvSchemes')+'ddtSchemes { default Euler; } gradSchemes { default Gauss linear; } divSchemes { default none; div(phi,c) Gauss linear; } laplacianSchemes { default Gauss linear corrected; } interpolationSchemes { default linear; } snGradSchemes { default corrected; }\n');
    put(p+'system/fvSolution',header('fvSolution')+'solvers { c { solver PBiCGStab; preconditioner DILU; tolerance 1e-13; relTol 0; maxIter 1000; } }\n');
    put(p+'constant/m53Properties',header('m53Properties')+`D ${c.D};\n`);
    put(p+'0/U',header('U','volVectorField')+`dimensions [0 1 -1 0 0 0 0]; internalField uniform (${c.u} 0 0);\n`+boundary);
    const initial=Array.from({length:c.n},(_,i)=>expected(c,(i+.5)/c.n,'pde',0));
    put(p+'0/c',header('c','volScalarField')+`dimensions [0 0 0 0 0 0 0]; internalField nonuniform List<scalar>\n${c.n}\n(\n${initial.join('\n')}\n);\n`+boundary);
  }
  writeFileSync(join(root,'input-manifest.json'),JSON.stringify(hashes,null,2)+'\n');return {cases:cases().length,files:Object.keys(hashes).length};
}
function tsv(path,columns){
  const lines=readFileSync(path,'utf8').trim().split('\n');assert.equal(lines.shift(),columns.join('\t'));
  return lines.map(line=>{const v=line.split('\t').map(Number);assert.equal(v.length,columns.length);assert.ok(v.every(Number.isFinite));return v;});
}
export function analyse(root,mode='suite'){
  assert.ok(['pilot','suite'].includes(mode));
  for(const [name,hash] of Object.entries(JSON.parse(readFileSync(join(root,'input-manifest.json'),'utf8')))){
    const path=resolve(root,name);assert.ok(path.startsWith(resolve(root)+'/'),'Escaping manifest path');
    assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'),hash,`Changed input ${name}`);
  }
  const frozen=JSON.parse(readFileSync(join(root,'protocol.json'),'utf8'));
  assert.deepEqual(frozen,{...protocol,cases:cases()},'Protocol drift');
  const results=[];
  const selected=mode==='pilot'?cases().filter(c=>['diffusion-space-20','blank'].includes(c.id)):cases();
  for(const c of selected){
    const path=join(root,'cases',c.id),rows=tsv(join(path,'m53-final.tsv'),['x','c','volume']);
    const history=tsv(join(path,'m53-mass.tsv'),['time','mass']),steps=Math.round(protocol.T/c.dt);
    assert.equal(rows.length,c.n);assert.equal(history.length,steps+1);
    history.forEach(([t],i)=>assert.ok(Math.abs(t-i*c.dt)<1e-10,'Time sequence mismatch'));
    rows.forEach(([x,,v],i)=>{assert.ok(Math.abs(x-(i+.5)/c.n)<1e-10);assert.ok(Math.abs(v-protocol.width**2/c.n)<1e-12);});
    const log=readFileSync(join(path,'solver.log'),'utf8');
    assert.match(readFileSync(join(path,'mesh-check.log'),'utf8'),/Mesh OK/);
    const endMarkers=[...log.matchAll(/^M53_END time=(\S+) steps=(\d+)\s*$/gm)];
    assert.equal(endMarkers.length,1,'Expected one completion marker');
    assert.ok(Math.abs(Number(endMarkers[0][1])-protocol.T)<1e-10,'Completion time mismatch');
    assert.equal(Number(endMarkers[0][2]),steps,'Completion step mismatch');
    assert.doesNotMatch(log,/FOAM FATAL|Segmentation fault|^\s*Floating point exception(?: \(core dumped\))?$|\bnan\b/im);
    const mass0=c.kind==='blank'?0:protocol.mean*protocol.L*protocol.width**2;
    const massError=Math.max(...history.map(([,m])=>Math.abs(m-mass0)));
    assert.ok(massError<=protocol.gates.massAbsolute,`${c.id}: mass conservation`);
    const rms=mode=>Math.sqrt(rows.reduce((s,[x,y])=>s+(y-expected(c,x,mode))**2,0)/c.n);
    const errorDiscrete=rms('discrete');assert.ok(errorDiscrete<=protocol.gates.discreteRms,`${c.id}: discrete operator mismatch`);
    if(c.kind==='blank') assert.ok(rows.every(([,y])=>Math.abs(y)<=protocol.gates.blankAbsolute));
    results.push({...c,massError,errorPde:rms('pde'),errorTemporal:rms('semidiscrete'),errorDiscrete});
  }
  const orders=[];
  if(mode==='suite')for(const kind of ['diffusion','advection','combined'])for(const series of ['space','time']){
    const rr=results.filter(r=>r.kind===kind&&r.series===series),key=series==='space'?'errorPde':'errorTemporal';
    for(let i=1;i<rr.length;i++){
      const order=Math.log2(rr[i-1][key]/rr[i][key]);
      assert.ok(Number.isFinite(order)&&order>=(series==='space'?protocol.gates.spatialOrderMin:protocol.gates.temporalOrderMin),`${kind}/${series}: convergence order ${order}`);
      orders.push({kind,series,coarse:rr[i-1].id,fine:rr[i].id,order});
    }
  }
  return {verified:true,mode,convergenceVerified:mode==='suite',scope:'Constant-coefficient source-free numerical verification only; not methane or GSL validation',results,orders};
}
export function pack(root){
  root=resolve(root);assert.ok(!existsSync(root),'Refuse bundle overwrite');mkdirSync(root,{recursive:true});
  generate(join(root,'suite'));
  mkdirSync(join(root,'solver'));
  for(const name of ['m53Transport.C','Make'])cpSync(`aws/openfoam-transport/${name}`,join(root,'solver',name),{recursive:true});
  for(const name of ['run.sh','dispatch.py','output_manifest.py'])cpSync(`aws/openfoam-transport/${name}`,join(root,name));
  cpSync('scripts/m53-transport.mjs',join(root,'independent-verifier.mjs'));
  const hashes={};
  function visit(dir){for(const entry of readdirSync(dir,{withFileTypes:true})){
    const p=join(dir,entry.name);if(entry.isDirectory())visit(p);else hashes[p.slice(root.length+1)]=createHash('sha256').update(readFileSync(p)).digest('hex');
  }}visit(root);
  writeFileSync(join(root,'bundle-manifest.json'),JSON.stringify(hashes,null,2)+'\n');
  return {cases:cases().length,files:Object.keys(hashes).length,root};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [mode,root]=process.argv.slice(2);assert.ok(root,'Usage: node m53-transport.mjs generate|analyse ROOT');
  console.log(JSON.stringify(mode==='generate'?generate(root):mode==='analyse'?analyse(root):mode==='analyse-pilot'?analyse(root,'pilot'):mode==='package'?pack(root):assert.fail('Unknown mode'),null,2));
}
