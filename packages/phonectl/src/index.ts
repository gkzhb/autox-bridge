import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
export { status } from './status.js';
export type { StatusOptions } from './status.js';

export class PhoneError extends Error {
  constructor(public code: string, message: string, public details?: unknown) { super(message); this.name = 'PhoneError'; }
}
export interface ExecOptions { as: 'termux' | 'shell'; argv: string[]; timeoutMs?: number; maxOutputBytes?: number; rishPath?: string }
export interface ExecResult {
  backend: 'termux' | 'shell'; identity: { uid: number | null; verified: boolean };
  exitCode: number | null; signal: string | null; stdout: string; stderr: string;
  timedOut: boolean; completion: 'exited' | 'unconfirmed';
}
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
export async function execute(options: ExecOptions): Promise<ExecResult> {
  if (!['termux','shell'].includes(options.as) || !options.argv.length || options.argv.some(v => typeof v !== 'string' || v.includes('\0')) || !options.argv[0]) throw new PhoneError('INVALID_ARGUMENT', 'Expected backend and nonempty argv without NUL');
  const timeoutMs = options.timeoutMs ?? 30000;
  const limit = options.maxOutputBytes ?? 1024 * 1024;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3600000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 4 * 1024 * 1024) throw new PhoneError('INVALID_ARGUMENT', 'Timeout must be 1..3600000 ms; output limit 1..4194304 bytes');
  const marker = 'phonectl-' + randomUUID();
  const shell = options.as === 'shell';
  // rish on this device can discard stderr and return 0 for a nonzero command.
  // Frame BOTH command streams and status; never trust rish exit 0.
  // rish may route transport bytes to either pipe. Merge observed arrivals below;
  // this does not reconstruct a global write order or recover missing bytes.
  // Identity and execution share one invocation. Per-run shell-owned directory
  // is mode 0700; file size and execution time are bounded before framing.
  const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  const command = [
    'u=$(id -u) || exit 125',
    `if [ "$u" != 2000 ]; then printf '${marker}:mismatch:%s\\n' "$u"; exit 125; fi`,
    `printf '${marker}:verified\\n'`,
    'umask 077',
    'd=$(/system/bin/mktemp -d /data/local/tmp/phonectl.XXXXXXXXXX) || exit 125',
    'trap \'/system/bin/rm -rf -- "$d"\' EXIT',
    `(ulimit -f ${Math.ceil(limit / 512)}; /system/bin/timeout -s KILL ${seconds} ${options.argv.map(quote).join(' ')}) >"$d/out" 2>"$d/err"`,
    'r=$?',
    `printf '${marker}:result:%s\\n' "$r"`,
    '/system/bin/base64 "$d/out"',
    `printf '\\n${marker}:stderr\\n'`,
    '/system/bin/base64 "$d/err"',
    `printf '\\n${marker}:end\\n'`,
  ].join('; ');
  const file = shell ? options.rishPath ?? process.env.PHONECTL_RISH ?? path.join(os.homedir(),'rish') : options.argv[0]!;
  const args = shell ? ['-c', `{ ${command}; }`] : options.argv.slice(1);
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { shell:false, stdio:['ignore','pipe','pipe'], env:{...process.env, ...(shell ? {RISH_APPLICATION_ID:'com.termux'} : {})} });
    const out: Buffer[] = [], err: Buffer[] = []; let bytes=0, settled=false;
    const wireLimit=shell?limit*3+8192:limit;
    const clear=()=>{clearTimeout(timer); child.stdout.destroy(); child.stderr.destroy();child.unref();};
    const fail=(e: PhoneError)=>{if(!settled){settled=true;clear();reject(e);}};
    const result=(exitCode:number|null,signal:string|null,timedOut:boolean)=>{
      if(settled)return;
      let stdout=Buffer.concat(out).toString('utf8'),stderr=Buffer.concat(err).toString('utf8');
      const verified=stdout.includes(marker+':verified\n');
      if(shell){
        if(stdout.includes(marker+':mismatch:')){fail(new PhoneError('IDENTITY_MISMATCH','rish did not execute as Android shell uid=2000'));return;}
        if(!verified){fail(new PhoneError('SHIZUKU_UNAVAILABLE','rish did not confirm shell identity',{timedOut,completion:'unconfirmed'}));return;}
        const frame=new RegExp(`${marker}:result:(\\d+)\\n([A-Za-z0-9+/=\\s]*)\\n${marker}:stderr\\n([A-Za-z0-9+/=\\s]*)\\n${marker}:end\\n`).exec(stdout);
        if(!frame && !timedOut){fail(new PhoneError('RESULT_UNCONFIRMED','rish did not deliver a complete command result'));return;}
        if(frame){exitCode=Number(frame[1]);stdout=Buffer.from(frame[2]!.replace(/\s/g,''),'base64').toString('utf8');stderr=Buffer.from(frame[3]!.replace(/\s/g,''),'base64').toString('utf8');timedOut=timedOut||exitCode===124||exitCode===137;}
        else {stdout='';stderr='';exitCode=null;}
        if(Buffer.byteLength(stdout)+Buffer.byteLength(stderr)>limit){fail(new PhoneError('OUTPUT_LIMIT','Command output exceeded limit; descendants may still be running'));return;}
      }
      settled=true;clear();resolve({backend:options.as,identity:{uid:shell?2000:process.getuid?.()??null,verified:shell?verified:process.getuid!==undefined},exitCode,signal,stdout,stderr,timedOut,completion:timedOut?'unconfirmed':'exited'});
    };
    const timer=setTimeout(()=>{child.kill('SIGKILL');result(null,'SIGKILL',true);},timeoutMs+(shell?2000:0));
    const append=(target:Buffer[],chunk:Buffer)=>{bytes+=chunk.length;if(bytes>wireLimit){child.kill('SIGKILL');fail(new PhoneError('OUTPUT_LIMIT','Command output exceeded limit; descendants may still be running'));}else target.push(chunk);};
    child.stdout.on('data',b=>append(out,b));child.stderr.on('data',b=>append(shell?out:err,b));
    child.once('error',e=>fail(new PhoneError(shell?'SHIZUKU_UNAVAILABLE':'COMMAND_UNAVAILABLE',e.message)));
    child.once('close',(code,signal)=>result(code,signal,false));
  });
}
