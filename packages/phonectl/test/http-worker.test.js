import test from 'node:test';
import assert from 'node:assert/strict';
import {createApi,describe,decode} from '../runner/http-api.mjs';
import http from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';

test('HTTP worker deadline is unknown, health remains responsive, and late completion never becomes success',async t=>{
 let release;const key='b'.repeat(64);
 const api=createApi({key,execute:()=>new Promise(resolve=>{release=resolve;})});
 const server=http.createServer(api.handler);await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(()=>{api.close();server.closeAllConnections();server.close();});
 const base='http://127.0.0.1:'+server.address().port,headers={Authorization:'Bearer '+key,'Content-Type':'application/json'};
 const request={version:1,requestId:'33333333-3333-4333-8333-333333333333',attempt:'44444444-4444-4444-8444-444444444444',deadline:Date.now()+500,timeoutMs:500,maxOutputBytes:1000,command:{mode:'shell',script:'fixed'}};
 assert.equal((await fetch(base+'/v1/executions',{method:'POST',headers,body:JSON.stringify(request)})).status,202);
 await delay(550);
 const state=await(await fetch(base+'/v1/executions/'+request.requestId+'?attempt='+request.attempt,{headers})).json();
 assert.equal(state.state,'unknown');assert.equal(state.error.code,'WAIT_TIMEOUT');
 const health=await(await fetch(base+'/v1/health',{headers})).json();assert.equal(health.busy,true);
 release({exitCode:0});await delay(5);
 const after=await(await fetch(base+'/v1/executions/'+request.requestId+'?attempt='+request.attempt,{headers})).json();
 assert.equal(after.state,'unknown');assert.equal(after.result,undefined);
});

test('HTTP Shizuku decoder retains exact command, separate streams and actual exit status',()=>{
 const r={requestId:'11111111-1111-4111-8111-111111111111',timeoutMs:1000,command:{mode:'argv',argv:['printf','%s',"a'b 中文🙂",'$(echo no)']},maxOutputBytes:100};
 const execution=describe(r),end='\nPHONECTL_HTTP_END_'+r.requestId;
 const output=decode(r,{result:'PHONECTL_UID2000\nfixed out'+end,error:'fixed err'+end,code:7});
 assert.equal(output.exitCode,7);assert.equal(output.stdout,'fixed out');assert.equal(output.stderr,'fixed err');
 assert.equal(output.execution.executedCommand,execution.executedCommand);
 assert.throws(()=>decode(r,{result:'wrong'+end,error:end,code:0}),/IDENTITY_MISMATCH/);
 assert.throws(()=>decode(r,{result:'PHONECTL_UID2000\nout',error:end,code:0}),/RESULT_UNCONFIRMED/);
});
