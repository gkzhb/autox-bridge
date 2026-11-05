import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
const exec=promisify(execFile);
const bin=fileURLToPath(new URL('../bin/phonectl.js',import.meta.url));
const run=async(args,env={})=>{try{return {...await exec(process.execPath,[bin,...args],{timeout:15000,env:{...process.env,...env}}),code:0};}catch(e){return {stdout:e.stdout,stderr:e.stderr,code:e.code};}};
test('help/version and JSON argv execution preserve command exit, output and diagnostic channels',async()=>{
 assert.match((await run(['--help'])).stdout,/Termux/);
 assert.equal((await run(['--version'])).stdout.trim(),'0.1.0');
 const r=await run(['--json','exec','--as','termux','--',process.execPath,'-e','process.stdout.write("hello");process.stderr.write("diag");process.exitCode=7']);
 assert.equal(r.code,7); assert.equal(r.stderr,'');
 const j=JSON.parse(r.stdout); assert.equal(j.ok,true); assert.equal(j.result.exitCode,7);assert.equal(j.result.stdout,'hello');assert.equal(j.result.stderr,'diag');
 const bad=await run(['--json','exec','--as','termux','--','/does/not/exist']);
 assert.equal(bad.code,1);assert.equal(JSON.parse(bad.stdout).error.code,'COMMAND_UNAVAILABLE');assert.match(bad.stderr,/COMMAND_UNAVAILABLE/);
 const usage=await run(['--json','exec','--as','root','--','id']); assert.equal(JSON.parse(usage.stdout).error.code,'INVALID_ARGUMENT');
 const missingDelimiter=await run(['--json','exec','id']);assert.equal(JSON.parse(missingDelimiter.stdout).error.code,'INVALID_ARGUMENT');
});
test('explicit shell mode is distinct; unknown commands and timeout are structured',async()=>{
 const shell=await run(['--json','shell','--as','termux','--script','printf "%s" "shell mode"']);
 assert.equal(shell.code,0);assert.equal(JSON.parse(shell.stdout).result.stdout,'shell mode');
 const literal=await run(['exec','--',process.execPath,'-e','process.stdout.write(process.argv[1])','--','--json']);
 assert.equal(literal.stdout,'--json');
 const missing=await run(['--json','not-a-command']); assert.equal(JSON.parse(missing.stdout).error.code,'INVALID_ARGUMENT');
 const r=await run(['--json','exec','--timeout','50','--',process.execPath,'-e','setInterval(()=>{},1000)']);
 assert.equal(r.code,124);assert.equal(JSON.parse(r.stdout).result.completion,'unconfirmed');
});
