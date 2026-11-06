import test from 'node:test';
import assert from 'node:assert/strict';
import {execute} from '../dist/index.js';
import {describeAutoX,validateAutoXResult,receiveAutoX} from '../dist/autox.js';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';

test('AutoX is explicitly selected and cannot silently run under Termux identity',async()=>{
 await assert.rejects(execute({as:'termux',backend:'autox',argv:['id']}),e=>e.code==='INVALID_ARGUMENT');
});

const request=command=>({version:1,requestId:'11111111-1111-4111-8111-111111111111',attempt:'22222222-2222-4222-8222-222222222222',deadline:Date.now()+10000,timeoutMs:10000,maxOutputBytes:1024,command});
const result=r=>({version:1,requestId:r.requestId,attempt:r.attempt,execution:describeAutoX(r),identity:{uid:2000,verified:true},stdout:'fixed out',stderr:'fixed err',exitCode:7});

test('AutoX exact command results preserve argv quoting and reject modified mode/argv/script/executed text',()=>{
 const r=request({mode:'argv',argv:['/system/bin/printf','%s','a b',"a'b",'中文🙂','$(echo nope)','']});
 const v=result(r),accepted=validateAutoXResult(r,v);
 assert.equal(accepted.execution.executedCommand,v.execution.executedCommand);
 assert.match(v.execution.userCommand,/'a'\\''b'/);
 assert.ok(v.execution.executedCommand.includes('/system/bin/timeout -s KILL'));
 assert.ok(v.execution.executedCommand.includes('PHONECTL_END_'+r.requestId));
 assert.equal(accepted.exitCode,7);
 for(const change of [x=>x.execution.command.argv[2]='changed',x=>x.execution.command={mode:'shell',script:'id'},x=>x.execution.userCommand+=' ',x=>x.execution.executedCommand+=' ',x=>x.attempt='33333333-3333-4333-8333-333333333333',x=>x.identity.uid=0]){
   const modified=structuredClone(v);change(modified);
   assert.throws(()=>validateAutoXResult(r,modified),e=>['COMMAND_MISMATCH','RESULT_MISMATCH','IDENTITY_MISMATCH'].includes(e.code));
 }
 const shell=request({mode:'shell',script:'printf "fixed"; exit 7'});
 assert.equal(validateAutoXResult(shell,result(shell)).execution.command.script,shell.command.script);
 const modified=result(shell);modified.execution.command={mode:'shell',script:'other'};
 assert.throws(()=>validateAutoXResult(shell,modified),e=>e.code==='COMMAND_MISMATCH');
 const oversized=result(r);oversized.stdout='x'.repeat(1025);
 assert.throws(()=>validateAutoXResult(r,oversized),e=>e.code==='OUTPUT_LIMIT');
 const failed=result(r);failed.error={code:'AUTOX_UNAVAILABLE'};
 assert.throws(()=>validateAutoXResult(r,failed),e=>e.code==='AUTOX_UNAVAILABLE');
});

test('actual fixed runner deletes only its request on success, backend failure and malformed input',async()=>{
 const template=await readFile(new URL('../runner/autox-runner.js',import.meta.url),'utf8');
 for(const mode of ['success','unavailable','malformed','expired','identity']){
  const r=request({mode:'argv',argv:['/system/bin/printf','%s',"a'b 中文"]});
  if(mode==='expired')r.deadline=Date.now()-1;
  const name='request-'+r.requestId+'-'+r.attempt+'.json';
  const entries=new Set([name,'other-user-file']);let removed=false,invoked;
  class File {
   constructor(a,b){this.name=b??a.split('/').at(-1);this.path=b?a+'/'+b:a;}
   listFiles(){return [...entries].map(n=>new File('/sdcard/phonectl',n));}
   getName(){return this.name;}getPath(){return this.path;}length(){return 100;}
   createNewFile(){if(entries.has(this.name))return false;entries.add(this.name);return true;}
   delete(){entries.delete(this.name);if(this.name===name)removed=true;return true;}
   exists(){return entries.has(this.name);}
  }
  class JString {constructor(s){this.s=s;}getBytes(){return Buffer.from(this.s);}}
  class Intent {setClassName(){}putExtra(){}}
  const shizuku=cmd=>{assert.equal(removed,true,'delete request before Shizuku call');invoked=cmd;const marker='PHONECTL_END_'+r.requestId;return{result:(mode==='identity'?'wrong-uid':'PHONECTL_UID2000\nout\n')+'\n'+marker,error:'err\n'+marker,code:7};};
  shizuku.isAlive=()=>mode!=='unavailable';
  let payload;
  const host={java:{io:{File},lang:{String:JString,Class:{forName:()=>null},reflect:{Array:{newInstance:()=>[]}}}},android:{content:{Intent}},context:{startService(){}},files:{read:()=>mode==='malformed'?'{':JSON.stringify(r)},shizuku};
  // Observe data passed to the fixed callback, never evaluate it as shell.
  Intent.prototype.putExtra=function(k,v){if(k==='com.termux.RUN_COMMAND_ARGUMENTS')payload=JSON.parse(v[1]);};
  const source=template.replace('/*PHONECTL_CONFIG*/null',JSON.stringify({publicDirectory:'/sdcard/phonectl',node:'/fixed/node',receiver:'/private/receiver'}));
  vm.runInNewContext(source,host,{timeout:1000});
  assert.equal(entries.has(name),false);assert.equal(entries.has(name+'.claim'),false);assert.equal(entries.has('other-user-file'),true);
  assert.equal(payload.requestId,r.requestId);assert.equal(payload.attempt,r.attempt);
  if(mode==='success'){assert.equal(invoked,describeAutoX(r).executedCommand);assert.equal(payload.exitCode,7);}
  else assert.ok(payload.error);
 }
});

test('fixed receiver binds private pending state, creates one atomic result and rejects duplicates/late callbacks',async t=>{
 const home=await mkdtemp(path.join(os.tmpdir(),'phonectl-autox-home-'));
 const original=process.env.HOME;process.env.HOME=home;
 t.after(async()=>{process.env.HOME=original;await rm(home,{recursive:true,force:true});});
 const r=request({mode:'argv',argv:['id','-u']});
 const dir=path.join(home,'.local/state/phonectl/autox',r.requestId+'-'+r.attempt);
 await mkdir(dir,{recursive:true,mode:0o700});await writeFile(path.join(dir,'pending.json'),JSON.stringify(r));
 await receiveAutoX(JSON.stringify(result(r)));
 const saved=JSON.parse(await readFile(path.join(dir,'result.json'),'utf8'));
 assert.equal(saved.ok,true);assert.equal(saved.result.exitCode,7);
 assert.equal(saved.result.requestId,r.requestId);assert.equal(saved.result.attempt,r.attempt);
 await assert.rejects(receiveAutoX(JSON.stringify(result(r))),e=>e.code==='EEXIST');
 await rm(dir,{recursive:true});
 await assert.rejects(receiveAutoX(JSON.stringify(result(r))),e=>e.code==='ENOENT');
 await mkdir(dir);r.deadline=Date.now()-1;await writeFile(path.join(dir,'pending.json'),JSON.stringify(r));
 await assert.rejects(receiveAutoX(JSON.stringify(result(r))),e=>e.code==='RESULT_EXPIRED');
 await assert.rejects(readFile(path.join(dir,'result.json')),e=>e.code==='ENOENT');
 r.deadline=Date.now()+10000;await writeFile(path.join(dir,'pending.json'),JSON.stringify(r));
 const altered=result(r);altered.execution.executedCommand+=' different';
 await receiveAutoX(JSON.stringify(altered));
 const rejection=JSON.parse(await readFile(path.join(dir,'result.json'),'utf8'));
 assert.equal(rejection.ok,false);assert.equal(rejection.error.code,'COMMAND_MISMATCH');
});
