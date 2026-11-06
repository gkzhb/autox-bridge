import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execute} from '../dist/index.js';
import {pairHttp,expectedHttpCommand} from '../dist/autox-http.js';
import {describe} from '../runner/http-api.mjs';

test('HTTP client uses private pairing, independently compares command/IDs and never accepts rewritten results',async t=>{
 const home=await mkdtemp(path.join(os.tmpdir(),'phonectl-http-client-')),old=process.env.HOME;process.env.HOME=home;
 let received,change='none',submits=0;
 const key='c'.repeat(64);
 const server=http.createServer(async(req,res)=>{
  assert.equal(req.headers.authorization,'Bearer '+key);
  let data;
  if(req.method==='POST'){let b='';for await(const c of req)b+=c;received=JSON.parse(b);submits++;data={requestId:received.requestId,attempt:received.attempt,state:'running'};res.statusCode=202;}
  else {
   const result={backend:'autox-http',requestId:received.requestId,attempt:received.attempt,identity:{uid:2000,verified:true},stdout:'fixed',stderr:'error',exitCode:7,signal:null,timedOut:false,completion:'exited',execution:describe(received)};
   if(change==='command')result.execution.executedCommand+='changed';
   if(change==='argv')result.execution.command={mode:'argv',argv:['different']};
   if(change==='script')result.execution.command={mode:'shell',script:'different'};
   if(change==='id')result.attempt='different';
   data={requestId:received.requestId,attempt:received.attempt,state:'completed',result};
  }
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify(data));
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));process.env.HOME=old;await rm(home,{recursive:true,force:true});});
 await assert.rejects(pairHttp(JSON.stringify({version:1,baseUrl:'http://0.0.0.0:1234',key,expiresAt:Date.now()+60000})),e=>e.code==='INVALID_ARGUMENT');
 await pairHttp(JSON.stringify({version:1,baseUrl:'http://127.0.0.1:'+server.address().port,key,expiresAt:Date.now()+60000}));
 const opts={as:'shell',backend:'autox-http',argv:['printf','%s',"a'b",'中文🙂','$(echo no)',''],timeoutMs:3000};
 const r=await execute(opts);assert.equal(r.exitCode,7);assert.equal(r.stdout,'fixed');
 assert.equal(r.execution.executedCommand,expectedHttpCommand(received.command,received.requestId,3000).executedCommand);
 for(const kind of ['command','argv','id','script']){change=kind;await assert.rejects(execute(kind==='script'?{...opts,argv:[],script:'printf fixed'}:opts),e=>['COMMAND_MISMATCH','RESULT_MISMATCH'].includes(e.code));}
 assert.equal(submits,5,'no automatic submit retries');
});
