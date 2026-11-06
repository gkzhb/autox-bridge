import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {execute} from '../dist/index.js';
import {pairHttp} from '../dist/autox-http.js';
import {describe} from '../runner/http-api.mjs';
const exec=promisify(execFile),bin=fileURLToPath(new URL('../bin/phonectl.js',import.meta.url));
async function fixture(t){
 const home=await mkdtemp(path.join(os.tmpdir(),'phonectl-select-')),old=process.env.HOME;
 process.env.HOME=home;
 const calls=[],rish=path.join(home,'rish'),receipt=path.join(home,'rish-called');
 await writeFile(rish,`#!${process.execPath}
import {writeFileSync} from 'node:fs';
writeFileSync(${JSON.stringify(receipt)},'called');
const marker=/phonectl-[0-9a-f-]+/.exec(process.argv[3])[0];
process.stdout.write(marker+':verified\\n'+marker+':result:0\\ncmlzaC1maXh0dXJl\\n'+marker+':stderr\\n\\n'+marker+':end\\n');
`,{mode:0o700});
 let submitted;
 const server=http.createServer(async(req,res)=>{
  calls.push(req.method+' '+req.url);res.setHeader('Content-Type','application/json');
  if(req.url==='/v1/health'){res.end(JSON.stringify({version:1,ok:true,busy:false,transport:'AutoX embedded Node direct Java Shizuku'}));return;}
  if(req.method==='POST'){let body='';for await(const c of req)body+=c;submitted=JSON.parse(body);res.statusCode=202;res.end(JSON.stringify({requestId:submitted.requestId,attempt:submitted.attempt,state:'running'}));return;}
  res.end(JSON.stringify({requestId:submitted.requestId,attempt:submitted.attempt,state:'completed',result:{backend:'autox-http',requestId:submitted.requestId,attempt:submitted.attempt,identity:{uid:2000,verified:true},stdout:'http-fixture',stderr:'',exitCode:7,signal:null,timedOut:false,completion:'exited',execution:describe(submitted)}}));
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 await pairHttp(JSON.stringify({version:1,baseUrl:'http://127.0.0.1:'+server.address().port,key:'a'.repeat(64),expiresAt:Date.now()+60000}));
 t.after(async()=>{server.closeAllConnections();if(server.listening)await new Promise(r=>server.close(r));process.env.HOME=old;await rm(home,{recursive:true,force:true});});
 const cli=async args=>{try{return {...await exec(process.execPath,[bin,'--json',...args],{env:{...process.env,PHONECTL_RISH:rish},timeout:15000}),code:0};}catch(e){return {stdout:e.stdout,stderr:e.stderr,code:e.code};}};
 return {home,calls,rish,receipt,cli,server,get submitted(){return submitted;}};
}

test('CLI defaults to HTTP shell identity and preserves a real nonzero command result',async t=>{
 const f=await fixture(t);
 const r=await f.cli(['exec','--','id','-u']);
 assert.equal(r.code,7);const j=JSON.parse(r.stdout);assert.equal(j.ok,true);assert.equal(j.result.backend,'autox-http');assert.equal(j.result.identity.uid,2000);assert.equal(j.result.stdout,'http-fixture');
 assert.equal(f.calls.filter(s=>s.startsWith('POST ')).length,1);
 await assert.rejects(readFile(f.receipt),{code:'ENOENT'});
});

test('explicit rish bypasses HTTP; missing pairing auto fallback records actual backend and reason',async t=>{
 const f=await fixture(t);
 await writeFile(path.join(f.home,'.local/state/phonectl/http/pairing.json'),'malformed pairing must not be read by rish');
 const explicit=await f.cli(['exec','--backend','rish','--','id','-u']);
 assert.equal(explicit.code,0);assert.equal(JSON.parse(explicit.stdout).result.backend,'rish');assert.deepEqual(f.calls,[]);
 await rm(path.join(f.home,'.local/state/phonectl/http/pairing.json'));
 const fallback=await execute({as:'shell',backend:'auto',rishPath:f.rish,argv:['id','-u']});
 assert.equal(fallback.backend,'rish');assert.equal(fallback.stdout,'rish-fixture');
 assert.deepEqual(fallback.fallback,{from:'autox-http',reason:'HTTP_NOT_PAIRED'});assert.deepEqual(f.calls,[]);
});

test('fallback rish failures record actual backend and safe reason without exposing pairing',async t=>{
 const f=await fixture(t);
 await rm(path.join(f.home,'.local/state/phonectl/http/pairing.json'));
 await assert.rejects(execute({as:'shell',backend:'auto',argv:['id'],rishPath:path.join(f.home,'missing-rish')}),e=>{
  assert.equal(e.code,'SHIZUKU_UNAVAILABLE');assert.deepEqual(e.details,{backend:'rish',fallback:{from:'autox-http',reason:'HTTP_NOT_PAIRED'}});return true;
 });
 assert.deepEqual(f.calls,[]);
});

test('CLI shell, legacy flags and Termux selection remain distinct, invalid combinations fail clearly',async t=>{
 const f=await fixture(t);
 for(const args of [['shell','--script','printf fixed'],['exec','--as','shell','--','id'],['exec','--backend','autox-http','--','id']]){
  const r=await f.cli(args);assert.equal(r.code,7);assert.equal(JSON.parse(r.stdout).result.backend,'autox-http');
 }
 const shell=await f.cli(['shell','--backend','rish','--script','printf fixed']);assert.equal(shell.code,0);assert.equal(JSON.parse(shell.stdout).result.backend,'rish');
 const termux=await f.cli(['exec','--as','termux','--',process.execPath,'-e','process.stdout.write("termux-fixed")']);assert.equal(termux.code,0);assert.equal(JSON.parse(termux.stdout).result.backend,'termux');
 const termuxShell=await f.cli(['shell','--as','termux','--script','printf termux-shell']);assert.equal(JSON.parse(termuxShell.stdout).result.stdout,'termux-shell');
 const before=f.calls.length;
 for(const backend of ['auto','rish','autox','autox-http','invalid']){
  for(const args of [['exec','--as','termux','--backend',backend,'--','id'],['shell','--as','termux','--backend',backend,'--script','id']]){const r=await f.cli(args);assert.equal(r.code,1);assert.equal(JSON.parse(r.stdout).error.code,'INVALID_ARGUMENT');}
 }
 assert.equal(f.calls.length,before);
 await rm(path.join(f.home,'.local/state/phonectl/http/pairing.json'));
 const fallbackShell=await f.cli(['shell','--script','printf fixed']);const r=JSON.parse(fallbackShell.stdout).result;
 assert.equal(r.backend,'rish');assert.equal(r.fallback.reason,'HTTP_NOT_PAIRED');
 for(const backend of ['auto','rish','autox','autox-http'])await assert.rejects(execute({as:'termux',backend,argv:['id']}),e=>e.code==='INVALID_ARGUMENT');
});

test('auto uses valid expired pairing or real refused preflight fallback, not malformed pairing',async t=>{
 const f=await fixture(t),pair=path.join(f.home,'.local/state/phonectl/http/pairing.json'),opts={as:'shell',backend:'auto',rishPath:f.rish,argv:['id']};
 const config=JSON.parse(await readFile(pair,'utf8'));
 await new Promise(r=>f.server.close(r));
 const refused=await execute(opts);assert.equal(refused.backend,'rish');assert.equal(refused.fallback.reason,'HTTP_UNAVAILABLE');
 await writeFile(pair,JSON.stringify({...config,expiresAt:Date.now()-1}));
 const expired=await execute(opts);assert.equal(expired.fallback.reason,'HTTP_EXPIRED');
 await rm(f.receipt);await writeFile(pair,'{');
 await assert.rejects(execute(opts),e=>e.code==='HTTP_PAIRING_INVALID');
 await assert.rejects(readFile(f.receipt),{code:'ENOENT'});
 await writeFile(pair,JSON.stringify({...config,baseUrl:'http://example.invalid:1234'}));
 await assert.rejects(execute(opts),e=>e.code==='HTTP_PAIRING_INVALID');
});

test('invalid oversized auto command cannot bypass HTTP validation through missing-pairing fallback',async t=>{
 const f=await fixture(t);
 await rm(path.join(f.home,'.local/state/phonectl/http/pairing.json'));
 await assert.rejects(execute({as:'shell',backend:'auto',rishPath:f.rish,argv:['printf','x'.repeat(33000)]}),e=>e.code==='INVALID_ARGUMENT');
 await assert.rejects(readFile(f.receipt),{code:'ENOENT'});
});

test('auto preflight proven connection refusal falls back, but ambiguous preflight and all submit/result errors fail closed',async t=>{
 const f=await fixture(t),original=globalThis.fetch;
 t.after(()=>{globalThis.fetch=original;});
 const opts={as:'shell',backend:'auto',rishPath:f.rish,argv:['id','-u'],timeoutMs:500};
 const refused=()=>new TypeError('fetch failed',{cause:Object.assign(new Error('refused'),{code:'ECONNREFUSED'})});
 globalThis.fetch=async()=>{throw refused();};
 const safe=await execute(opts);assert.equal(safe.backend,'rish');assert.deepEqual(safe.fallback,{from:'autox-http',reason:'HTTP_UNAVAILABLE'});
 await rm(f.receipt);
 for(const mode of ['preflight-reset','preflight-timeout','preflight-unknown','preflight-mixed','preflight-body','preflight-401','preflight-403','preflight-busy','preflight-protocol','submit-refused','submit-reset','submit-timeout','submit-401','submit-403','submit-busy','submit-protocol','result-reset','result-timeout','result-unknown','result-protocol','result-command','result-identity']){
  let posts=0,request;
  globalThis.fetch=async(url,init)=>{
   if(url.endsWith('/v1/health')){
    if(mode==='preflight-reset')throw Object.assign(new Error(),{code:'ECONNRESET'});
    if(mode==='preflight-timeout')throw new DOMException('timeout','TimeoutError');
    if(mode==='preflight-unknown')throw new Error('unknown transport stage');
    if(mode==='preflight-mixed')throw new AggregateError([refused(),new Error('unknown')]);
    if(mode==='preflight-body')return new Response(new ReadableStream({start(c){c.error(refused());}}));
    if(mode==='preflight-401'||mode==='preflight-403')return new Response('{}',{status:Number(mode.slice(-3))});
    return Response.json(mode==='preflight-protocol'?{ok:true}:{version:1,ok:true,busy:mode==='preflight-busy',transport:'AutoX embedded Node direct Java Shizuku'});
   }
   if(init.method==='POST'){
    posts++;request=JSON.parse(init.body);
    if(mode==='submit-refused')throw refused();
    if(mode==='submit-reset')throw Object.assign(new Error(),{code:'ECONNRESET'});
    if(mode==='submit-timeout')throw new DOMException('timeout','TimeoutError');
    if(mode==='submit-401'||mode==='submit-403')return new Response('{}',{status:Number(mode.slice(-3))});
    if(mode==='submit-busy')return new Response('{}',{status:409});
    if(mode==='submit-protocol')return new Response('invalid');
    return Response.json({requestId:request.requestId,attempt:request.attempt,state:'running'});
   }
   if(mode==='result-reset')throw refused();
   if(mode==='result-timeout')throw new DOMException('timeout','TimeoutError');
   const result={backend:'autox-http',requestId:request.requestId,attempt:request.attempt,identity:{uid:mode==='result-identity'?0:2000,verified:true},stdout:'fixed',stderr:'',exitCode:0,execution:describe(request)};
   if(mode==='result-command')result.execution.executedCommand+='changed';
   return Response.json({requestId:request.requestId,attempt:request.attempt,state:mode==='result-unknown'?'unknown':mode==='result-protocol'?'invalid':'completed',result});
  };
  await assert.rejects(execute(opts),e=>typeof e.code==='string',mode);
  assert.equal(posts,mode.startsWith('preflight-')?0:1,mode+': no repeated POST');
  await assert.rejects(readFile(f.receipt),{code:'ENOENT'},mode+': no rish fallback');
 }
});
