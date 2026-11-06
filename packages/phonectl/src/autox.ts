import {access, mkdir, readFile, writeFile, open, rename, unlink, rmdir, readdir} from 'node:fs/promises';
import {watch} from 'node:fs';
import {spawn} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {PhoneError} from './index.js';
import {awaitResult} from './autox-result.js';
import type {ExecOptions,ExecResult} from './index.js';

const PUBLIC='/sdcard/phonectl';
const root=()=>path.join(os.homedir(),'.local/state/phonectl/autox');
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export type AutoXCommand={mode:'argv';argv:string[]}|{mode:'shell';script:string};
export interface AutoXRequest {version:1;requestId:string;attempt:string;deadline:number;timeoutMs:number;maxOutputBytes:number;command:AutoXCommand}
export interface AutoXExecution {command:AutoXCommand;userCommand:string;executedCommand:string}
const quote=(s:string)=>"'"+s.replaceAll("'","'\\''")+"'";
export function describeAutoX(request:AutoXRequest):AutoXExecution {
  const command=request.command;
  const userCommand=command.mode==='argv'?command.argv.map(quote).join(' '):command.script;
  const marker='PHONECTL_END_'+request.requestId;
  const executedCommand=`u=$(/system/bin/id -u) || exit 125; if [ "$u" != 2000 ]; then exit 125; fi; printf 'PHONECTL_UID2000\\n'; /system/bin/timeout -s KILL ${Math.max(1,Math.ceil(request.timeoutMs/1000))} /system/bin/sh -c ${quote(userCommand)}; r=$?; printf '\\n${marker}\\n'; printf '\\n${marker}\\n' >&2; (exit "$r")`;
  return {command,userCommand,executedCommand};
}
function validRequest(r:AutoXRequest) {
  if(r?.version!==1||!uuid.test(r.requestId)||!uuid.test(r.attempt)||!Number.isSafeInteger(r.deadline)||!Number.isSafeInteger(r.timeoutMs)||r.timeoutMs<1||r.timeoutMs>3600000||!Number.isSafeInteger(r.maxOutputBytes)||r.maxOutputBytes<1||r.maxOutputBytes>16384)throw new PhoneError('INVALID_ARGUMENT','Invalid AutoX request envelope');
  const c=r.command;
  if(!c||!(c.mode==='argv'&&Array.isArray(c.argv)&&c.argv.length&&c.argv[0]&&c.argv.every(v=>typeof v==='string'&&!v.includes('\0'))||c.mode==='shell'&&typeof c.script==='string'&&!c.script.includes('\0')))throw new PhoneError('INVALID_ARGUMENT','Invalid AutoX command');
  if(Buffer.byteLength(JSON.stringify(r))>32768)throw new PhoneError('INVALID_ARGUMENT','AutoX request exceeds 32 KiB');
}
export function validateAutoXResult(request:AutoXRequest,value:unknown):ExecResult {
  const r=value as Record<string,any>;
  validRequest(request);
  if(r?.version!==1||r.requestId!==request.requestId||r.attempt!==request.attempt)throw new PhoneError('RESULT_MISMATCH','AutoX result is not bound to this request/attempt');
  const expected=describeAutoX(request);
  const cmd=r.execution?.command;
  const same=cmd?.mode===expected.command.mode&&(expected.command.mode==='argv'?Array.isArray(cmd.argv)&&cmd.argv.length===expected.command.argv.length&&cmd.argv.every((s:unknown,i:number)=>s===(expected.command as {argv:string[]}).argv[i]):cmd.script===(expected.command as {script:string}).script);
  if(!same||r.execution?.userCommand!==expected.userCommand||r.execution?.executedCommand!==expected.executedCommand)throw new PhoneError('COMMAND_MISMATCH','AutoX command differs from private expected command');
  if(r.error)throw new PhoneError(typeof r.error.code==='string'?r.error.code:'AUTOX_UNAVAILABLE','AutoX runner did not confirm execution');
  if(r.identity?.uid!==2000||r.identity?.verified!==true)throw new PhoneError('IDENTITY_MISMATCH','AutoX did not confirm same-call shell uid2000');
  if(typeof r.stdout!=='string'||typeof r.stderr!=='string'||!Number.isInteger(r.exitCode)||r.exitCode<0||r.exitCode>255)throw new PhoneError('RESULT_UNCONFIRMED','Invalid AutoX result fields');
  if(Buffer.byteLength(r.stdout)+Buffer.byteLength(r.stderr)>request.maxOutputBytes)throw new PhoneError('OUTPUT_LIMIT','AutoX output exceeds requested limit');
  return {backend:'autox',identity:{uid:2000,verified:true},stdout:r.stdout,stderr:r.stderr,exitCode:r.exitCode,signal:null,timedOut:r.exitCode===124||r.exitCode===137,completion:r.exitCode===124||r.exitCode===137?'unconfirmed':'exited',execution:expected,requestId:request.requestId,attempt:request.attempt};
}
const remove=async(p:string)=>{try{await unlink(p);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}};

// Fixed receiver entry. This is consistency checking, NOT authenticated IPC.
export async function receiveAutoX(payload:string):Promise<void> {
  if(Buffer.byteLength(payload)>131072)throw new PhoneError('OUTPUT_LIMIT','AutoX callback exceeds limit');
  const r=JSON.parse(payload);
  if(!uuid.test(r?.requestId)||!uuid.test(r?.attempt))throw new PhoneError('RESULT_MISMATCH','Invalid callback IDs');
  const dir=path.join(root(),r.requestId+'-'+r.attempt);
  const request=JSON.parse(await readFile(path.join(dir,'pending.json'),'utf8')) as AutoXRequest;
  if(Date.now()>request.deadline)throw new PhoneError('RESULT_EXPIRED','AutoX result arrived after deadline');
  let accepted:object;
  try{accepted={ok:true,result:validateAutoXResult(request,r)};}catch(e){const err=e as PhoneError;accepted={ok:false,error:{code:err.code??'RESULT_UNCONFIRMED',message:err.message}};}
  const claim=await open(path.join(dir,'received'),'wx',0o600);await claim.close();
  try {
    // Re-check live pending state after claiming to reject timeout races.
    await access(path.join(dir,'pending.json'));
    if(Date.now()>request.deadline)throw new PhoneError('RESULT_EXPIRED','AutoX result expired');
    await writeFile(path.join(dir,'result.tmp'),JSON.stringify(accepted),{flag:'wx',mode:0o600});
    await rename(path.join(dir,'result.tmp'),path.join(dir,'result.json'));
  } catch(e){await remove(path.join(dir,'result.tmp'));throw e;}
}

export async function installAutoX():Promise<{runner:string;sha256:string;publicDirectory:string}> {
  await mkdir(PUBLIC,{recursive:true});await mkdir(root(),{recursive:true,mode:0o700});
  const receiver=path.join(root(),'receiver-v2.mjs');
  const receiverText=`import {receiveAutoX} from ${JSON.stringify(pathToFileURL(fileURLToPath(new URL('./autox.js',import.meta.url))).href)}; import {writeFileSync} from 'node:fs'; try { await receiveAutoX(process.argv[2]??''); } catch(e) { writeFileSync(${JSON.stringify(path.join(root(),'last-receiver-error.json'))},JSON.stringify({at:Date.now(),code:e.code??'RECEIVER_ERROR'}),{mode:0o600}); process.exitCode=1; }\n`;
  let prior:string|undefined;try{prior=await readFile(receiver,'utf8');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  if(prior!==undefined&&prior!==receiverText)throw new PhoneError('INSTALL_CONFLICT','Refusing to overwrite unknown AutoX receiver');
  if(prior===undefined)await writeFile(receiver,receiverText,{flag:'wx',mode:0o600});
  const template=await readFile(new URL('../runner/autox-runner.js',import.meta.url),'utf8');
  const source=template.replace('/*PHONECTL_CONFIG*/null',JSON.stringify({publicDirectory:PUBLIC,node:process.execPath,receiver}));
  const sha256=createHash('sha256').update(source).digest('hex');
  const runner=path.join(PUBLIC,'runner-v1-'+sha256.slice(0,16)+'.js');
  try{await writeFile(runner,source,{flag:'wx'});}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST'||await readFile(runner,'utf8')!==source)throw new PhoneError('INSTALL_CONFLICT','Unknown existing AutoX runner');}
  const manifest={runner,sha256,publicDirectory:PUBLIC};
  await writeFile(path.join(root(),'install.json'),JSON.stringify(manifest),{mode:0o600});return manifest;
}

export async function executeAutoX(options:ExecOptions):Promise<ExecResult> {
  if(options.as!=='shell')throw new PhoneError('INVALID_ARGUMENT','AutoX backend requires --as shell');
  const timeout=options.timeoutMs??30000;
  if(!Number.isSafeInteger(timeout)||timeout<1||timeout>3600000)throw new PhoneError('INVALID_ARGUMENT','AutoX timeout must be 1..3600000ms');
  const request:AutoXRequest={version:1,requestId:randomUUID(),attempt:randomUUID(),deadline:Date.now()+timeout,timeoutMs:timeout,maxOutputBytes:options.maxOutputBytes??16384,command:options.script===undefined?{mode:'argv',argv:options.argv}:{mode:'shell',script:options.script}};
  validRequest(request);
  const installed=JSON.parse(await readFile(path.join(root(),'install.json'),'utf8').catch(()=>{throw new PhoneError('AUTOX_NOT_INSTALLED','Run phonectl autox-install first');}));
  const source=await readFile(installed.runner);
  if(createHash('sha256').update(source).digest('hex')!==installed.sha256)throw new PhoneError('RUNNER_CHANGED','Public runner hash changed; review before reinstall');
  const lock=path.join(root(),'active.lock');
  try{await mkdir(lock);}catch{throw new PhoneError('AUTOX_BUSY','Only one AutoX request is supported; do not remove an active lock');}
  const dir=path.join(root(),request.requestId+'-'+request.attempt);
  const reqPath=path.join(PUBLIC,'request-'+request.requestId+'-'+request.attempt+'.json');
  let uncertain=false;
  const claimPath=reqPath+'.claim';let stopWatching:(()=>void)|undefined;
  try {
    await writeFile(path.join(lock,'owner.json'),JSON.stringify({pid:process.pid,requestId:request.requestId,attempt:request.attempt,deadline:request.deadline}),{flag:'wx',mode:0o600});
    if((await readdir(PUBLIC)).some(n=>/^request-.*\.json(?:\.claim)?$/.test(n)))throw new PhoneError('AUTOX_BUSY','Unfinished shared request exists; inspect it instead of starting concurrently');
    await mkdir(dir,{mode:0o700});await writeFile(path.join(dir,'pending.json'),JSON.stringify(request),{flag:'wx',mode:0o600});
    const awaited=awaitResult<{ok:boolean;result:ExecResult;error:{code:string;message:string}}>({
      read:async()=>JSON.parse(await readFile(path.join(dir,'result.json'),'utf8')),
      subscribe:(notify,fail)=>{const watcher=watch(dir,notify);watcher.on('error',fail);return()=>watcher.close();}
    },request.deadline);
    stopWatching=awaited.close;
    const response=awaited.result.then(r=>{if(r.ok)return r.result;throw new PhoneError(r.error.code,r.error.message);}).catch(e=>{if(e.code==='AUTOX_TIMEOUT')throw new PhoneError('AUTOX_TIMEOUT',e.message);throw e;});
    // Attach a rejection handler immediately, even if launch fails first.
    void response.catch(()=>{});
    await writeFile(reqPath,JSON.stringify(request),{flag:'wx'});
    await new Promise<void>((resolve,reject)=>{
      const am=path.join(process.env.PREFIX??'/data/data/com.termux/files/usr','bin/am');
      const child=spawn(am,['start','-n','org.autojs.autoxjs.v7/org.autojs.autojs.external.open.RunIntentActivity','-d',pathToFileURL(installed.runner).href],{shell:false,stdio:'ignore'});
      const launchTimer=setTimeout(()=>{child.kill();reject(new PhoneError('AUTOX_UNAVAILABLE','AutoX launcher deadline'));},Math.min(timeout,8000));
      child.once('error',()=>{clearTimeout(launchTimer);reject(new PhoneError('AUTOX_UNAVAILABLE','AutoX launcher unavailable'));});
      child.once('close',code=>{clearTimeout(launchTimer);code===0?resolve():reject(new PhoneError('AUTOX_UNAVAILABLE','AutoX launcher failed'));});
    });
    return await response;
  } catch(e) {
    uncertain=(e as PhoneError).code==='AUTOX_TIMEOUT'||(e as PhoneError).message==='AutoX launcher deadline';
    throw e;
  } finally {
    stopWatching?.();
    // Atomic retirement removes the callback's entire live namespace first.
    // A receiver already holding old state cannot recreate it (never mkdirs).
    const retired=dir+'.retired';
    let retiredExists=false;
    try{await rename(dir,retired);retiredExists=true;}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
    await remove(reqPath);await remove(claimPath);
    if(retiredExists){
      for(const file of ['pending.json','received','result.tmp','result.json'])await remove(path.join(retired,file));
      await rmdir(retired);
    }
    if(!uncertain){await remove(path.join(lock,'owner.json'));await rmdir(lock);}
  }
}
