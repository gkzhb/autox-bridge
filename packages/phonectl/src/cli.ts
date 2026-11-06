import { Command, Option } from 'commander';
import path from 'node:path';
import { execute, installAutoX, installHttp, PhoneError, status } from './index.js';
import type { ExecOptions, ExecResult } from './index.js';

type Selection={as:'termux'|'shell';backend?:ExecOptions['backend']};
const selected=(opts:Selection):Selection=>({as:opts.as,backend:opts.backend??(opts.as==='shell'?'auto':undefined)});
const integer=(s:string)=>{const n=Number(s);if(!Number.isSafeInteger(n)||n<1)throw new PhoneError('INVALID_ARGUMENT','Expected positive integer milliseconds');return n;};
export async function main(argv=process.argv):Promise<void> {
  const delimiter=argv.indexOf('--',2);
  const json=argv.slice(2,delimiter<0?undefined:delimiter).includes('--json');
  const program=new Command().name('phonectl').description('Termux-local phone control; HTTP-first Shizuku shell, explicit rish or Termux').version('0.1.0').option('--json','Single structured JSON result on stdout; diagnostics on stderr');
  program.exitOverride().configureOutput({writeErr:()=>{}});
  const output=(result:unknown)=>console.log(JSON.stringify({ok:true,result},null,json?undefined:2));
  const done=(r:ExecResult)=>{if(json)output(r);else{process.stdout.write(r.stdout);process.stderr.write(r.stderr);}process.exitCode=r.timedOut?124:r.exitCode??1;};
  program.command('http-install').description('Install short-lived AutoX .mjs loopback HTTP server; prints path, never API key').option('--lifetime <ms>','Maximum server lifetime',integer,120000).action(async(opts:{lifetime:number})=>output(await installHttp(opts.lifetime)));
  program.command('autox-install').description('Install fixed public AutoX runner and private receiver').action(async()=>output(await installAutoX()));
  program.command('status').description('Read-only environment facts; unobservable backend state is unknown').action(async()=>output(await status()));
  program.command('exec').description('Execute literal argv (requires --); default HTTP-first shell').addOption(new Option('--as <identity>','Execution identity (default shell)').choices(['termux','shell']).default('shell')).addOption(new Option('--backend <backend>','Shell backend (default auto: HTTP then safe rish fallback)').choices(['auto','rish','autox','autox-http'])).option('--timeout <ms>','Command deadline',integer,30000).argument('[argv...]').allowUnknownOption().action(async(args:string[],opts:Selection&{timeout:number})=>{
    if(!argv.includes('--'))throw new PhoneError('INVALID_ARGUMENT','exec requires -- before executable and arguments');
    done(await execute({...selected(opts),argv:args,timeoutMs:opts.timeout}));
  });
  program.command('shell').description('Explicit trusted shell script; default HTTP-first shell').addOption(new Option('--as <identity>','Execution identity (default shell)').choices(['termux','shell']).default('shell')).requiredOption('--script <text>','Shell text to interpret explicitly').addOption(new Option('--backend <backend>','Shell backend (default auto: HTTP then safe rish fallback)').choices(['auto','rish','autox','autox-http'])).option('--timeout <ms>','Command deadline',integer,30000).action(async(opts:Selection&{script:string;timeout:number})=>{
    const file=opts.as==='shell'?'/system/bin/sh':path.join(process.env.PREFIX??'/data/data/com.termux/files/usr','bin/sh');
    const selection=selected(opts);
    done(await execute({...selection,argv:[file,'-c',opts.script],timeoutMs:opts.timeout,...(selection.backend&&selection.backend!=='rish'?{script:opts.script}:{})}));
  });
  try {await program.parseAsync(argv);}catch(error){
    const e=error as {code?:string;message?:string};
    if(e.code==='commander.helpDisplayed'||e.code==='commander.version')return;
    const failure=error instanceof PhoneError?error:new PhoneError(e.code?.startsWith('commander.')?'INVALID_ARGUMENT':'INTERNAL_ERROR',e.message??String(error));
    if(json)console.log(JSON.stringify({ok:false,error:{code:failure.code,message:failure.message,...(failure.details===undefined?{}:{details:failure.details})}}));
    console.error(`${failure.code}: ${failure.message}`);process.exitCode=1;
  }
}
