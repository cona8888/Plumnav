// Synthetic Fourier fixtures validate the oracle/checker, not OpenFOAM execution.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {cases,expected,generate,analyse,protocol} from './m53-transport.mjs';
function fixture(change){
  const temp=mkdtempSync(join(tmpdir(),'plumenav-m53-test-')),root=join(temp,'suite');
  try{
    generate(root);
    for(const c of cases()){
      const dir=join(root,'cases',c.id),steps=Math.round(protocol.T/c.dt),mass=c.kind==='blank'?0:.01;
      writeFileSync(join(dir,'m53-final.tsv'),'x\tc\tvolume\n'+Array.from({length:c.n},(_,i)=>{const x=(i+.5)/c.n;return `${x}\t${expected(c,x,'discrete')}\t${.01/c.n}`;}).join('\n')+'\n');
      writeFileSync(join(dir,'m53-mass.tsv'),'time\tmass\n'+Array.from({length:steps+1},(_,i)=>`${i*c.dt}\t${mass}`).join('\n')+'\n');
      writeFileSync(join(dir,'solver.log'),`M53_END time=0.2 steps=${steps}\n`);
      writeFileSync(join(dir,'mesh-check.log'),'Mesh OK.\n');
    }
    if(change)change(root);
    return analyse(root);
  }finally{rmSync(temp,{recursive:true,force:true});}
}
test('22 cases, exact initial mean and scaled cell averages',()=>{
  assert.equal(cases().length,22);
  for(const c of cases()){
    const values=Array.from({length:c.n},(_,i)=>expected(c,(i+.5)/c.n,'pde',0));
    assert.ok(Math.abs(values.reduce((a,b)=>a+b,0)/c.n-(c.kind==='blank'?0:1))<1e-14);
  }
});
test('fully discrete Fourier fixtures pass all frozen convergence gates',()=>{
  const r=fixture();assert.equal(r.verified,true);assert.equal(r.results.length,22);assert.equal(r.orders.length,15);
});
test('mass leakage is rejected',()=>assert.throws(()=>fixture(root=>{
  const p=join(root,'cases/blank/m53-mass.tsv');writeFileSync(p,readFileSync(p,'utf8').replace('0.1\t0\n','0.1\t0.0001\n'));
})));
test('modified initial condition is rejected by manifest',()=>assert.throws(()=>fixture(root=>{
  const p=join(root,'cases/combined-space-20/0/c');writeFileSync(p,readFileSync(p,'utf8')+'// altered\n');
})));
test('floating-point endpoint serialization is accepted without changing data',()=>{
  assert.equal(fixture(root=>{
    const p=join(root,'cases/diffusion-space-20/solver.log');
    writeFileSync(p,'M53_END time=0.19999999999999429 steps=2000\n');
  }).verified,true);
});
for(const marker of ['M53_END time=0.19 steps=2000','M53_END time=0.2 steps=1999','M53_END time=NaN steps=2000']){
  test(`invalid endpoint rejected: ${marker}`,()=>assert.throws(()=>fixture(root=>{
    writeFileSync(join(root,'cases/diffusion-space-20/solver.log'),marker+'\n');
  })));
}
