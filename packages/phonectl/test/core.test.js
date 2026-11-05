import test from 'node:test';
import assert from 'node:assert/strict';
import { execute } from '../dist/index.js';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('Termux argv preserves spaces, unicode, quotes and shell syntax as literal data', async () => {
  const args = ['two words', '中文🙂', `a'b"c`, '$(echo injected); echo nope', '', '*', '--flag'];
  const result = await execute({ as: 'termux', argv: [process.execPath, '-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', ...args] });
  assert.equal(result.backend, 'termux');
  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.stdout), args);
});

test('nonzero exit is a command result, missing executables are tool errors, timeout is unconfirmed', async () => {
  const result = await execute({as:'termux', argv:[process.execPath,'-e','process.stdout.write("out");process.stderr.write("err");process.exitCode=7']});
  assert.equal(result.exitCode,7); assert.equal(result.stdout,'out'); assert.equal(result.stderr,'err');
  await assert.rejects(execute({as:'termux',argv:['/missing/phonectl-command']}), e => e.code === 'COMMAND_UNAVAILABLE');
  const timeout = await execute({as:'termux',argv:[process.execPath,'-e','setInterval(()=>{},1000)'],timeoutMs:80});
  assert.equal(timeout.timedOut,true); assert.equal(timeout.completion,'unconfirmed');
  await assert.rejects(execute({as:'termux',argv:['echo','\u0000']}),e=>e.code==='INVALID_ARGUMENT');
  await assert.rejects(execute({as:'termux',argv:[process.execPath,'-e','process.stdout.write("x".repeat(100000))'],maxOutputBytes:100}),e=>e.code==='OUTPUT_LIMIT');
});

test('rish transport merges observed pipe arrivals without merging framed command output', async t => {
  const dir=await mkdtemp(path.join(os.tmpdir(),'phonectl-transport-')); t.after(()=>rm(dir,{recursive:true,force:true}));
  const rish=path.join(dir,'rish');
  // Executable backend boundary, not a mock of execute() internals. Await each
  // write and space deliveries to exercise observed arrivals across independent
  // pipes, not to promise reconstruction of arbitrary concurrent write order.
  await writeFile(rish,`#!${process.execPath}
const marker=/phonectl-[0-9a-f-]+/.exec(process.argv[3])[0];
const mode=process.argv[3].includes("'mismatch'")?'mismatch':process.argv[3].includes("'partial'")?'partial':'result';
const text=mode==='mismatch'?marker+':mismatch:1000\\n':marker+':verified\\n'+(mode==='partial'?'':marker+':result:0\\nb3V0IOS4reaWh/CfmYI=\\n'+marker+':stderr\\nZXJy\\n'+marker+':end\\n');
const bytes=Buffer.from(text);
const cuts=[9,marker.length+4,marker.length+10,Math.floor(bytes.length*0.7),bytes.length].filter((v,i,a)=>v>0&&v<=bytes.length&&(i===0||v>a[i-1]));
async function emit(){
let start=0;
for(let i=0;i<cuts.length;i++){
 const stream=process.argv[3].includes("'all-stderr'")?process.stderr:i%2?process.stdout:process.stderr;
 await new Promise(resolve=>stream.write(bytes.subarray(start,cuts[i]),resolve));
 start=cuts[i];
 await new Promise(resolve=>setTimeout(resolve,50));
}
}
emit().catch(error=>{console.error(error);process.exitCode=1;});
`,{mode:0o700});
  const result=await execute({as:'shell',rishPath:rish,argv:['fixed-text']});
  assert.equal(result.identity.uid,2000); assert.equal(result.identity.verified,true);
  assert.equal(result.stdout,'out 中文🙂'); assert.equal(result.stderr,'err');
  assert.equal(result.exitCode,0); assert.equal(result.completion,'exited');
  const stderrTransport=await execute({as:'shell',rishPath:rish,argv:['all-stderr']});
  assert.equal(stderrTransport.identity.verified,true);
  assert.equal(stderrTransport.stdout,'out 中文🙂'); assert.equal(stderrTransport.stderr,'err');
  await assert.rejects(execute({as:'shell',rishPath:rish,argv:['mismatch']}),e=>e.code==='IDENTITY_MISMATCH');
  await assert.rejects(execute({as:'shell',rishPath:rish,argv:['partial']}),e=>e.code==='RESULT_UNCONFIRMED');
});

test('rish argv is quoted, identity checked in the same invocation, failure never falls back', async t => {
  const dir=await mkdtemp(path.join(os.tmpdir(),'phonectl-rish-')); t.after(()=>rm(dir,{recursive:true,force:true}));
  const rish=path.join(dir,'rish'); const id=path.join(dir,'id');
  await writeFile(id,'#!/bin/sh\necho 2000\n',{mode:0o700});
  await writeFile(rish,`#!/bin/sh\ncmd=$(printf '%s' "$2" | sed 's|/data/local/tmp|${dir}|g')\nPATH='${dir}':"$PATH" /system/bin/sh -c "$cmd" 2>/dev/null\nexit 0\n`,{mode:0o700});
  const args=['a b',`a'b"c`,'中文','$(echo INJECTION); echo bad',''];
  const result=await execute({as:'shell',rishPath:rish,argv:['/system/bin/printf','%s\\n',...args]});
  assert.equal(result.identity.uid,2000); assert.equal(result.exitCode,0); assert.equal(result.stdout,args.join('\n')+'\n');
  const nonzero=await execute({as:'shell',rishPath:rish,argv:['/system/bin/sh','-c','printf out; printf err >&2; exit 7']});
  assert.equal(nonzero.exitCode,7);assert.equal(nonzero.stdout,'out');assert.equal(nonzero.stderr,'err');
  const timeout=await execute({as:'shell',rishPath:rish,argv:['/system/bin/sleep','3'],timeoutMs:30});
  assert.equal(timeout.timedOut,true);assert.equal(timeout.completion,'unconfirmed');
  await writeFile(rish,'#!/bin/sh\necho partial\nexit 0\n',{mode:0o700});
  await assert.rejects(execute({as:'shell',rishPath:rish,argv:['echo','no']}),e=>e.code==='SHIZUKU_UNAVAILABLE');
  await writeFile(rish,`#!/bin/sh
cmd=$(printf '%s' "$2" | sed 's|/data/local/tmp|${dir}|g')
PATH='${dir}':"$PATH" /system/bin/sh -c "$cmd" 2>/dev/null
exit 0
`,{mode:0o700});
  await writeFile(id,'#!/bin/sh\necho 1000\n',{mode:0o700});
  await assert.rejects(execute({as:'shell',rishPath:rish,argv:['echo','must not execute']}),e=>e.code==='IDENTITY_MISMATCH');
  await assert.rejects(execute({as:'shell',rishPath:path.join(dir,'missing'),argv:['echo','no']}),e=>e.code==='SHIZUKU_UNAVAILABLE');
  await writeFile(rish,'#!/bin/sh\necho denied >&2\nexit 1\n',{mode:0o700});
  await assert.rejects(execute({as:'shell',rishPath:rish,argv:['echo','no']}),e=>e.code==='SHIZUKU_UNAVAILABLE');
});
