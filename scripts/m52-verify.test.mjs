// Synthetic archive tests exercise the checker only, never CFD validity.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';

function check({suffix='s',times=[1,2,3,4,5],extra='',field='uniform (0 0 0);',corrupt=false,missing=false}={}) {
  const root=mkdtempSync(join(tmpdir(),'plumenav-m52-checker-'));
  try {
    const files={
      'COMPLETE.txt':'Compatibility only', 'package-versions.txt':'openfoam14\t20260724\n',
      'foamRun.log':`sigFpe : Enabling floating point exception trapping (FOAM_SIGFPE).\n${times.map(t=>`Time = ${t}${suffix}`).join('\n')}\n${extra}\nEnd\n`,
      'checkMesh.log':'Mesh OK.', 'blockMesh.log':'synthetic', 'configure.log':'synthetic',
      'foamRun-help.log':'synthetic', 'blockMesh-help.log':'synthetic',
      'pitzDailySteady/5/U':field, 'pitzDailySteady/5/p':'uniform 0;',
    };
    if(missing) delete files['pitzDailySteady/5/p'];
    const rows=[];
    for(const [name,text] of Object.entries(files)) {
      mkdirSync(dirname(join(root,name)),{recursive:true});
      writeFileSync(join(root,name),text);
      rows.push(`${createHash('sha256').update(text).digest('hex')}  ./${name}`);
    }
    writeFileSync(join(root,'SHA256SUMS'),rows.join('\n')+'\n');
    if(corrupt) writeFileSync(join(root,'pitzDailySteady/5/U'),'changed');
    return spawnSync(process.execPath,[resolve('scripts/m52-verify.mjs'),root],{encoding:'utf8'});
  } finally { rmSync(root,{recursive:true,force:true}); }
}

test('accepts v14 seconds and legacy bare endpoint formats',()=>{
  for(const suffix of ['s','']) { const r=check({suffix}); assert.equal(r.status,0,r.stderr); }
});
test('rejects wrong units, omitted iterations and duplicate iterations',()=>{
  for(const options of [{suffix:'ms'},{times:[1,2,3,4]},{times:[1,2,3,4,5,5]}]) assert.notEqual(check(options).status,0);
});
test('rejects actual fatal errors, not trap-enablement diagnostics',()=>{
  for(const extra of ['FOAM FATAL ERROR','Segmentation fault','Floating point exception','Floating point exception (core dumped)','value = nan']) assert.notEqual(check({extra}).status,0,extra);
});
test('rejects non-finite fields, changed checksums and missing fields',()=>{
  for(const options of [{field:'uniform nan;'},{field:'uniform inf;'},{corrupt:true},{missing:true}]) assert.notEqual(check(options).status,0);
});
