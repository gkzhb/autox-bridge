import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {PhoneError} from './index.js';
import type {ExecOptions,ExecResult} from './index.js';
const root=()=>path.join(os.homedir(),'.local/state/phonectl/http');
const quote=(s:string)=>"'"+s.replaceAll("'","'\\''")+"'";
export function expectedHttpCommand(command:{mode:'argv';argv:string[]}|{mode:'shell';script:string},requestId:string,timeoutMs:number){
 const userCommand=command.mode==='argv'?command.argv.map(quote).join(' '):command.script;
 const marker='PHONECTL_HTTP_END_'+requestId;
 return {command,userCommand,executedCommand:`u=$(/system/bin/id -u) || exit 125; if [ "$u" != 2000 ]; then exit 125; fi; printf 'PHONECTL_UID2000\\n'; /system/bin/timeout -s KILL ${Math.max(1,Math.ceil(timeoutMs/1000))} /system/bin/sh -c ${quote(userCommand)}; r=$?; printf '\\n${marker}\\n'; printf '\\n${marker}\\n' >&2; (exit "$r")`};
}
export async function pairHttp(text:string):Promise<void>{
 if(Buffer.byteLength(text)>2048)throw new PhoneError('INVALID_ARGUMENT','Pairing too large');
 const r=JSON.parse(text);const u=new URL(r.baseUrl);
 if(r.version!==1||u.protocol!=='http:'||u.hostname!=='127.0.0.1'||!u.port||u.username||u.password||u.pathname!=='/'||u.search||u.hash||!/^[a-f0-9]{64}$/.test(r.key)||!Number.isSafeInteger(r.expiresAt)||r.expiresAt<=Date.now()||r.expiresAt>Date.now()+600000)throw new PhoneError('INVALID_ARGUMENT','Invalid private HTTP pairing');
 await mkdir(root(),{recursive:true,mode:0o700});await writeFile(path.join(root(),'pairing.json'),JSON.stringify(r),{mode:0o600});
}
export async function installHttp(lifetimeMs=120000):Promise<{server:string;stop:string;publicDirectory:string;sha256:string;lifetimeMs:number}> {
 if(!Number.isSafeInteger(lifetimeMs)||lifetimeMs<10000||lifetimeMs>600000)throw new PhoneError('INVALID_ARGUMENT','Lifetime must be 10000..600000ms');
 await mkdir(root(),{recursive:true,mode:0o700});
 const receiver=path.join(root(),'pair-v1.mjs');
 const text=`import {pairHttp} from ${JSON.stringify(new URL('./autox-http.js',import.meta.url).href)}; try{await pairHttp(process.argv[2]??'');}catch{process.exitCode=1;}\n`;
 try{await writeFile(receiver,text,{flag:'wx',mode:0o600});}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST'||await readFile(receiver,'utf8')!==text)throw new PhoneError('INSTALL_CONFLICT','Unknown pairing receiver');}
 const publicDirectory='/sdcard/phonectl/http-'+randomUUID();await mkdir(publicDirectory);
 const api=await readFile(new URL('../runner/http-api.mjs',import.meta.url),'utf8');
 const template=await readFile(new URL('../runner/http-server.mjs',import.meta.url),'utf8');
 const server=path.join(publicDirectory,'server.mjs');
 const source=template.replace('/*PHONECTL_HTTP_CONFIG*/null',JSON.stringify({publicDirectory,server,node:process.execPath,receiver,lifetimeMs}));
 await writeFile(path.join(publicDirectory,'http-api.mjs'),api,{flag:'wx'});await writeFile(server,source,{flag:'wx'});
 const stop=path.join(publicDirectory,'stop.js');
 await writeFile(stop,`(function(){var a=engines.all(),ids=[],r={at:Date.now(),actions:[]};try{var m=JSON.parse(files.read(${JSON.stringify(path.join(publicDirectory,'listening.json'))}));if(Number.isInteger(m.engineId))ids.push(m.engineId);}catch(ignore){}for(var i=0;i<a.length;i++){var e=a[i];if(String(e.getSource())===${JSON.stringify('NodeScript@'+server)}){ids.push(Number(e.getId()));r.actions.push({id:Number(e.getId()),source:String(e.getSource())});e.forceStop();}}a=engines.all();var dir=String(context.getFilesDir().getAbsolutePath())+'/phonectl-http/';for(var j=0;j<a.length;j++){var x=a[j];for(var k=0;k<ids.length;k++)if(String(x.getSource())===dir+'watchdog-'+ids[k]+'.js'){x.forceStop();files.remove(dir+'watchdog-'+ids[k]+'.js');}}files.write(${JSON.stringify(path.join(publicDirectory,'stop-requested.json'))},JSON.stringify(r));}());\n`,{flag:'wx'});
 const sha256=createHash('sha256').update(source).digest('hex');const manifest={server,stop,publicDirectory,sha256,lifetimeMs};await writeFile(path.join(root(),'install.json'),JSON.stringify(manifest),{mode:0o600});return manifest;
}
type HttpPhase='pairing'|'preflight'|'submit'|'result';
function httpError(code:string,message:string,phase:HttpPhase,fallbackSafe=false):PhoneError {
 return new PhoneError(code,message,{phase,executionSubmitted:phase==='submit'?'unknown':phase==='result'?true:false,fallbackSafe});
}
function connectionRefused(error:unknown):boolean {
 if(!error||typeof error!=='object')return false;
 const e=error as {code?:string;cause?:unknown;errors?:unknown[]};
 if(e.code==='ECONNREFUSED')return true;
 if(Array.isArray(e.errors)&&e.errors.length)return e.errors.every(connectionRefused);
 return e.cause!==undefined&&connectionRefused(e.cause);
}
export async function executeHttp(options:ExecOptions):Promise<ExecResult>{
 if(options.as!=='shell')throw new PhoneError('INVALID_ARGUMENT','HTTP AutoX requires shell identity');
 const timeoutMs=options.timeoutMs??15000,limit=options.maxOutputBytes??16384;
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>60000||!Number.isSafeInteger(limit)||limit<1||limit>16384)throw new PhoneError('INVALID_ARGUMENT','HTTP timeout 1..60000ms, output 1..16384 bytes');
 const command=options.script===undefined?{mode:'argv' as const,argv:options.argv}:{mode:'shell' as const,script:options.script};
 if(command.mode==='argv'?!(Array.isArray(command.argv)&&command.argv.length&&command.argv[0]&&command.argv.every(s=>typeof s==='string'&&!s.includes('\0'))):typeof command.script!=='string'||command.script.includes('\0'))throw new PhoneError('INVALID_ARGUMENT','Invalid command');
 const requestId=randomUUID(),attempt=randomUUID(),deadline=Date.now()+timeoutMs;
 const request={version:1,requestId,attempt,deadline,timeoutMs,maxOutputBytes:limit,command};
 const expected=expectedHttpCommand(command,requestId,timeoutMs);
 if(Buffer.byteLength(JSON.stringify(request))>32768)throw new PhoneError('INVALID_ARGUMENT','Request exceeds 32KiB');
 let text:string;
 try{text=await readFile(path.join(root(),'pairing.json'),'utf8');}catch(e){
  if((e as NodeJS.ErrnoException).code==='ENOENT')throw httpError('HTTP_NOT_PAIRED','Start AutoX HTTP server and wait for private pairing','pairing',true);
  throw httpError('HTTP_PAIRING_INVALID','Cannot read private HTTP pairing','pairing');
 }
 let config:{version:number;baseUrl:string;key:string;expiresAt:number};
 try{
  config=JSON.parse(text);const u=new URL(config.baseUrl);
  if(Buffer.byteLength(text)>2048||config.version!==1||u.protocol!=='http:'||u.hostname!=='127.0.0.1'||!u.port||u.username||u.password||u.pathname!=='/'||u.search||u.hash||!/^[a-f0-9]{64}$/.test(config.key)||!Number.isSafeInteger(config.expiresAt)||config.expiresAt>Date.now()+600000)throw new Error();
 }catch{throw httpError('HTTP_PAIRING_INVALID','Invalid private HTTP pairing','pairing');}
 if(config.expiresAt<=Date.now())throw httpError('HTTP_EXPIRED','Short-lived AutoX server pairing expired','pairing',true);
 const headers={Authorization:'Bearer '+config.key,'Content-Type':'application/json'};
 const read=async(url:string,phase:HttpPhase,init:RequestInit={})=>{
  let r:Response;try{r=await fetch(config.baseUrl+url,{...init,headers,redirect:'error',signal:AbortSignal.timeout(Math.max(1,Math.min(5000,deadline-Date.now())))});}catch(e){throw httpError('HTTP_UNAVAILABLE','AutoX HTTP unavailable; execution is not automatically retried',phase,phase==='preflight'&&connectionRefused(e));}
  if(!r.ok){await r.body?.cancel();throw httpError(r.status===401||r.status===403?'HTTP_UNAUTHORIZED':r.status===409?'HTTP_BUSY':'HTTP_ERROR','AutoX HTTP rejected request',phase);}
  const reader=r.body?.getReader();let size=0,body='';
  try{if(reader){const decoder=new TextDecoder();while(true){const n=await reader.read();if(n.done)break;size+=n.value.length;if(size>131072){await reader.cancel();throw httpError('OUTPUT_LIMIT','HTTP response exceeds limit',phase);}body+=decoder.decode(n.value,{stream:true});}body+=decoder.decode();}}
  catch(e){if(e instanceof PhoneError)throw e;throw httpError('HTTP_UNAVAILABLE','HTTP response incomplete; execution is not automatically retried',phase);}
  let data;try{data=JSON.parse(body);if(!data||typeof data!=='object')throw new Error();}catch{throw httpError('RESULT_UNCONFIRMED','Invalid HTTP response',phase);}
  return data;
 };
 if(options.backend==='auto'){
  const health=await read('/v1/health','preflight');
  if(health.version!==1||health.ok!==true||typeof health.busy!=='boolean'||health.transport!=='AutoX embedded Node direct Java Shizuku')throw httpError('RESULT_UNCONFIRMED','Invalid HTTP health response','preflight');
  if(health.busy)throw httpError('HTTP_BUSY','AutoX HTTP worker is busy','preflight');
 }
 // Crossing this boundary is potentially committing an execution, even when
 // fetch throws before a response. Never infer "not submitted" from POST errors.
 const submitted=await read('/v1/executions','submit',{method:'POST',body:JSON.stringify(request)});
 if(submitted.requestId!==requestId||submitted.attempt!==attempt||!['running','completed','failed','unknown'].includes(submitted.state))throw httpError('RESULT_MISMATCH','HTTP submission binding mismatch','submit');
 while(Date.now()<deadline){
  const data=await read('/v1/executions/'+requestId+'?attempt='+attempt,'result');
  if(data.requestId!==requestId||data.attempt!==attempt)throw new PhoneError('RESULT_MISMATCH','HTTP request binding mismatch');
  if(data.state==='completed'){
   const r=data.result;if(r?.requestId!==requestId||r.attempt!==attempt)throw new PhoneError('RESULT_MISMATCH','HTTP result binding mismatch');
   if(JSON.stringify(r.execution?.command)!==JSON.stringify(command)||r.execution?.userCommand!==expected.userCommand||r.execution?.executedCommand!==expected.executedCommand)throw new PhoneError('COMMAND_MISMATCH','HTTP executed command differs from private expectation');
   if(r.identity?.uid!==2000||r.identity?.verified!==true)throw new PhoneError('IDENTITY_MISMATCH','HTTP shell identity unconfirmed');
   if(typeof r.stdout!=='string'||typeof r.stderr!=='string'||!Number.isInteger(r.exitCode)||r.exitCode<0||r.exitCode>255)throw new PhoneError('RESULT_UNCONFIRMED','Invalid execution result');
   if(Buffer.byteLength(r.stdout)+Buffer.byteLength(r.stderr)>limit)throw new PhoneError('OUTPUT_LIMIT','HTTP command output exceeded limit');
   return {...r,backend:'autox-http',signal:null,timedOut:r.exitCode===124||r.exitCode===137,completion:r.exitCode===124||r.exitCode===137?'unconfirmed':'exited'};
  }
  if(data.state==='failed'||data.state==='unknown')throw new PhoneError(data.state==='unknown'?'HTTP_TIMEOUT':'HTTP_EXECUTION_FAILED','AutoX command not confirmed; cancellation unconfirmed');
  if(data.state!=='running')throw httpError('RESULT_UNCONFIRMED','Invalid HTTP execution state','result');
  await new Promise(resolve=>setTimeout(resolve,100));
 }
 throw new PhoneError('HTTP_TIMEOUT','HTTP wait deadline; command cancellation unconfirmed');
}
