import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const source=new URL('../runner/shizuku-selfcheck.js',import.meta.url);
// AutoX host API is the OS boundary. This executes the actual distributed Rhino
// script, not a copied implementation or a mock of phonectl internals.
async function runHost({alive=true,uid='2000\n',uidCode=0,throws=false,streamCode=7}={}) {
  const calls=[],records=[];
  const shizuku=cmd=>{
    calls.push(cmd);
    if(throws)throw new Error('host backend failed');
    return cmd==='id -u'?{result:uid,error:'',code:uidCode}:{result:'AUTOX_STDOUT\n',error:'AUTOX_STDERR\n',code:streamCode};
  };
  shizuku.isAlive=()=>alive;
  const host={shizuku,console:{log:s=>records.push(JSON.parse(s))}};
  // No filesystem, Java process, Intent or network access is supplied. A
  // deployment must bootstrap this source independently of untrusted requests.
  vm.runInNewContext(await readFile(source,'utf8'),host,{timeout:1000});
  assert.equal(records.length,1,'one fixed structured diagnostic record');
  return {calls,record:records[0]};
}

test('fixed AutoX selfcheck records the documented host result without accepting command input',async()=>{
  const {calls,record}=await runHost();
  assert.equal(calls.length,2);
  assert.equal(calls[0],'id -u');
  assert.equal(calls[1],`/system/bin/sh -c 'printf "AUTOX_STDOUT\\n"; printf "AUTOX_STDERR\\n" >&2; exit 7'`);
  assert.equal(record.kind,'phonectl.autox-selfcheck.v1');
  assert.equal(record.ok,true);
  assert.equal(record.identity.uid,2000);
  assert.equal(record.probe.stdout,'AUTOX_STDOUT\n');
  assert.equal(record.probe.stderr,'AUTOX_STDERR\n');
  assert.equal(record.probe.code,7);
  assert.equal(record.probe.identityVerified,false,'prior id is not same-call identity proof');
});

test('selfcheck fails closed before fixed shell probes when the backend or shell identity is not confirmed',async()=>{
  for(const options of [{alive:false},{uid:'0\n'},{uid:'10248\n'},{uidCode:1},{throws:true}]){
    const {calls,record}=await runHost(options);
    assert.equal(record.ok,false);
    assert.ok(calls.length<=1,'no second command without accepted id');
    assert.equal(record.probe,undefined);
  }
});

test('selfcheck retains an unexpected reported exit code rather than claiming the expected result',async()=>{
  const {record}=await runHost({streamCode:0});
  assert.equal(record.ok,false);
  assert.equal(record.probe.code,0);
  assert.equal(record.error.code,'PROBE_MISMATCH');
});
