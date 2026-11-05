import { access, constants } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execute } from './index.js';
export interface StatusOptions { rishPath?: string; androidBin?: string }
export async function status(options:StatusOptions={}) {
 const bin=options.androidBin??'/system/bin';
 const observe=async(argv:string[])=>{try{const r=await execute({as:'termux',argv,timeoutMs:3000,maxOutputBytes:16384});return r.exitCode===0&&!r.timedOut?r.stdout.trim():null;}catch{return null;}};
 const [model,android,packagePath]=await Promise.all([observe([path.join(bin,'getprop'),'ro.product.model']),observe([path.join(bin,'getprop'),'ro.build.version.release']),observe([path.join(bin,'pm'),'path','org.autojs.autoxjs.v7'])]);
 const rishPath=options.rishPath??process.env.PHONECTL_RISH??path.join(os.homedir(),'rish');
 let present=false;try{await access(rishPath,constants.X_OK);present=true;}catch{}
 return {readOnly:true,device:{model:model||null,android:android||null},termux:{uid:process.getuid?.()??null,prefix:process.env.PREFIX??null,home:os.homedir(),platform:process.platform},rish:{path:rishPath,present,authorized:'unknown' as const,identity:'unknown' as const},autox:{package:'org.autojs.autoxjs.v7',installed:packagePath?.startsWith('package:')?true:'unknown' as const,running:'unknown' as const,entryAvailable:'unknown' as const},notes:['No rish/AutoX invocation, permission request, wake or service startup performed.','Package queries may be denied; unknown is not false.']};
}
