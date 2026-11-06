import http from 'node:http';
import {setTimeout,clearTimeout} from 'node:timers';
import fs from 'node:fs';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {loadClass,invokeIo} from 'java';
import {execScriptFile,myEngine} from 'engines';
import {createApi,describe,decode} from './http-api.mjs';
const config=/*PHONECTL_HTTP_CONFIG*/null;
const phase=name=>fs.writeFileSync(config.publicDirectory+'/phase.json',JSON.stringify({at:Date.now(),phase:name}));
const Context=loadClass('com.stardust.app.GlobalAppContext').get();
const dir=String(Context.getFilesDir().getAbsolutePath())+'/phonectl-http';
fs.mkdirSync(dir,{recursive:true,mode:0o700});
const keyPath=dir+'/api-key';
// New per-instance key rotates only this manually started server's credential.
// Existing instances must be stopped before starting another one.
const key=randomBytes(32).toString('hex');
fs.writeFileSync(keyPath,key,{mode:0o600});
if(!/^[a-f0-9]{64}$/.test(key))throw new Error('Invalid private key; no unauthenticated fallback');
const Api=loadClass('com.stardust.autojs.runtime.api.Shizuku');
const shizuku=new Api(Context);
const expiresAt=Date.now()+config.lifetimeMs;
const api=createApi({key,expiresAt:()=>expiresAt,onExpired:()=>close(),execute:async request=>{
 if(!shizuku.isShizukuAlive())throw new Error('SHIZUKU_UNAVAILABLE');
 const execution=describe(request);
 const raw=await invokeIo(shizuku,'runShizukuShellCommand',[execution.executedCommand]);
 return decode(request,raw);
}});
const server=http.createServer({maxHeaderSize:8192,requestTimeout:5000,headersTimeout:3000,connectionsCheckingInterval:1000},api.handler);
server.maxConnections=8;server.keepAliveTimeout=1000;server.timeout=5000;
let closed=false;
function close(){if(closed)return;closed=true;api.close();server.closeAllConnections?.();server.close(()=>{try{fs.writeFileSync(config.publicDirectory+'/closed.json',JSON.stringify({at:Date.now(),closed:true,busy:api.busy}));}catch{}});}
process.on('exit',()=>{try{api.close();server.close();}catch{}});
const engineId=Number(myEngine().id);
const watchdog=dir+'/watchdog-'+engineId+'.js';
const watchdogCode="(function(){try{sleep("+config.lifetimeMs+");var a=engines.all();for(var n=0;n<a.length;n++){var e=a[n];if(Number(e.getId())==="+engineId+"&&String(e.getSource())==="+JSON.stringify('NodeScript@'+config.server)+"){e.forceStop();files.write("+JSON.stringify(config.publicDirectory+'/watchdog.json')+",JSON.stringify({at:Date.now(),engineId:"+engineId+",action:'targeted forceStop requested'}));}}}finally{files.remove("+JSON.stringify(watchdog)+");}}());";
fs.writeFileSync(watchdog,watchdogCode,{mode:0o600});execScriptFile(watchdog);
const lifetime=setTimeout(close,config.lifetimeMs);
server.on('error',()=>{fs.writeFileSync(config.publicDirectory+'/error.json',JSON.stringify({at:Date.now(),code:'LISTEN_FAILED'}));clearTimeout(lifetime);close();});
server.listen(0,'127.0.0.1',()=>{
 const port=server.address().port;
 const pairing={version:1,baseUrl:'http://127.0.0.1:'+port,key,expiresAt};
 // Public receipt deliberately excludes the key and any commands/output.
 fs.writeFileSync(config.publicDirectory+'/listening.json',JSON.stringify({at:Date.now(),node:process.version,address:'127.0.0.1',port,expiresAt:pairing.expiresAt,directShizuku:true,engineId}));
 try{
  phase('pair-helper');
  const helper=dir+'/pair-once.js';
  const code="(function(){try{var i=new android.content.Intent('com.termux.RUN_COMMAND');i.setClassName('com.termux','com.termux.app.RunCommandService');i.putExtra('com.termux.RUN_COMMAND_PATH',"+JSON.stringify(config.node)+");var a=java.lang.reflect.Array.newInstance(java.lang.Class.forName('java.lang.String'),2);a[0]="+JSON.stringify(config.receiver)+";a[1]="+JSON.stringify(JSON.stringify(pairing))+";i.putExtra('com.termux.RUN_COMMAND_ARGUMENTS',a);i.putExtra('com.termux.RUN_COMMAND_BACKGROUND',true);context.startService(i);}finally{files.remove("+JSON.stringify(helper)+");}}());";
  fs.writeFileSync(helper,code,{mode:0o600});
  execScriptFile(helper,{onSuccess(){phase('pair-submitted');},onException(){try{fs.unlinkSync(helper);}catch{}phase('pair-helper-failed');close();}});
 }catch{fs.writeFileSync(config.publicDirectory+'/error.json',JSON.stringify({at:Date.now(),code:'PAIRING_FAILED'}));clearTimeout(lifetime);close();}
});
