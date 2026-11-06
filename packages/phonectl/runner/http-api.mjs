import {timingSafeEqual} from 'node:crypto';
import {setTimeout,clearTimeout,setInterval,clearInterval} from 'node:timers';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function validRequest(r){
 if(!r||r.version!==1||!uuid.test(r.requestId)||!uuid.test(r.attempt)||!Number.isSafeInteger(r.deadline)||r.deadline<=Date.now()||r.deadline>Date.now()+60000||!Number.isSafeInteger(r.timeoutMs)||r.timeoutMs<1||r.timeoutMs>60000||!Number.isSafeInteger(r.maxOutputBytes)||r.maxOutputBytes<1||r.maxOutputBytes>16384)throw new Error('INVALID_REQUEST');
 const c=r.command;
 if(!c||!(c.mode==='argv'&&Array.isArray(c.argv)&&c.argv.length&&c.argv[0]&&c.argv.every(x=>typeof x==='string'&&!x.includes('\0'))||c.mode==='shell'&&typeof c.script==='string'&&!c.script.includes('\0')))throw new Error('INVALID_COMMAND');
 if(Buffer.byteLength(JSON.stringify(r))>32768)throw new Error('REQUEST_TOO_LARGE');
}
export const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
export function describe(r){const command=r.command,userCommand=command.mode==='argv'?command.argv.map(quote).join(' '):command.script,marker='PHONECTL_HTTP_END_'+r.requestId;
 return {command,userCommand,executedCommand:`u=$(/system/bin/id -u) || exit 125; if [ "$u" != 2000 ]; then exit 125; fi; printf 'PHONECTL_UID2000\\n'; /system/bin/timeout -s KILL ${Math.max(1,Math.ceil(r.timeoutMs/1000))} /system/bin/sh -c ${quote(userCommand)}; r=$?; printf '\\n${marker}\\n'; printf '\\n${marker}\\n' >&2; (exit "$r")`};}
export function decode(r,raw){
 const execution=describe(r),suffix='\nPHONECTL_HTTP_END_'+r.requestId;
 const strip=s=>{s=String(s);if(!s.endsWith(suffix))throw new Error('RESULT_UNCONFIRMED');return s.slice(0,-suffix.length);};
 let stdout=strip(raw.result),stderr=strip(raw.error);
 if(stdout!=='PHONECTL_UID2000'&&!stdout.startsWith('PHONECTL_UID2000\n'))throw new Error('IDENTITY_MISMATCH');
 stdout=stdout==='PHONECTL_UID2000'?'':stdout.slice('PHONECTL_UID2000\n'.length);
 if(Buffer.byteLength(stdout)+Buffer.byteLength(stderr)>r.maxOutputBytes)throw new Error('OUTPUT_LIMIT');
 const exitCode=Number(raw.code);if(!Number.isInteger(exitCode)||exitCode<0||exitCode>255)throw new Error('RESULT_UNCONFIRMED');
 return {backend:'autox-http',requestId:r.requestId,attempt:r.attempt,identity:{uid:2000,verified:true},stdout,stderr,exitCode,signal:null,timedOut:exitCode===124||exitCode===137,completion:exitCode===124||exitCode===137?'unconfirmed':'exited',execution};
}
export function createApi({key,execute,ttlMs=60000,maxResults=32,expiresAt=()=>Infinity,onExpired=()=>{}}){
 if(typeof key!=='string'||!/^[a-f0-9]{64}$/.test(key))throw new Error('KEY_REQUIRED');
 const records=new Map();let busy=false,closed=false;
 const clean=()=>{const now=Date.now();for(const[k,v]of records)if(v.finished&&now-v.finished>ttlMs)records.delete(k);};
 const sweep=setInterval(clean,Math.min(ttlMs,10000));sweep.unref?.();
 const send=(res,status,data)=>{if(!res.destroyed){res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','Connection':'close'});res.end(JSON.stringify(data));}};
 function handler(req,res){
  if(closed)return send(res,503,{error:'CLOSED'});
  const auth=req.headers.authorization,expected=Buffer.from('Bearer '+key),actual=Buffer.from(typeof auth==='string'?auth:'');
  if(actual.length!==expected.length||!timingSafeEqual(actual,expected))return send(res,401,{error:'UNAUTHORIZED'});
  if(req.headers.origin||req.headers['transfer-encoding']||req.rawHeaders.filter((_,i)=>i%2===0&&req.rawHeaders[i].toLowerCase()==='authorization').length!==1)return send(res,403,{error:'FORBIDDEN'});
  if(!/^127\.0\.0\.1:[0-9]+$/.test(req.headers.host??''))return send(res,403,{error:'HOST_REJECTED'});
  if(Date.now()>=expiresAt()){send(res,503,{error:'EXPIRED'});onExpired();return;}
  clean();const u=new URL(req.url,'http://127.0.0.1');
  if(req.method==='GET'&&u.pathname==='/v1/health')return send(res,200,{version:1,ok:true,busy,transport:'AutoX embedded Node direct Java Shizuku'});
  if(req.method==='GET'&&u.pathname.startsWith('/v1/executions/')){const id=u.pathname.slice('/v1/executions/'.length),v=records.get(id);if(!v||u.searchParams.get('attempt')!==v.request.attempt)return send(res,404,{error:'NOT_FOUND'});if(v.state==='running'&&Date.now()>v.request.deadline){v.state='unknown';v.error={code:'WAIT_TIMEOUT',message:'Deadline exceeded; cancellation unconfirmed'};}return send(res,200,{version:1,requestId:id,attempt:v.request.attempt,state:v.state,...(v.result?{result:v.result}:{}),...(v.error?{error:v.error}:{})});}
  if(req.method!=='POST'||u.pathname!=='/v1/executions')return send(res,404,{error:'NOT_FOUND'});
  if(!req.headers['content-type']?.startsWith('application/json'))return send(res,415,{error:'CONTENT_TYPE'});
  const chunks=[];let bytes=0;let rejected=false;req.setTimeout(3000,()=>{rejected=true;req.destroy();});
  req.on('data',chunk=>{bytes+=chunk.length;if(bytes>32768){if(!rejected)send(res,413,{error:'REQUEST_TOO_LARGE'});rejected=true;}else chunks.push(chunk);});
  req.on('end',()=>{if(rejected)return;let r;try{r=JSON.parse(Buffer.concat(chunks).toString('utf8'));validRequest(r);}catch{return send(res,400,{error:'INVALID_REQUEST'});}
   const old=records.get(r.requestId);if(old){if(JSON.stringify(old.request)!==JSON.stringify(r))return send(res,409,{error:'REQUEST_MISMATCH'});return send(res,200,{requestId:r.requestId,attempt:r.attempt,state:old.state});}
   if(busy||records.size>=maxResults)return send(res,409,{error:'BUSY'});
   const entry={request:r,state:'running'};records.set(r.requestId,entry);busy=true;
   send(res,202,{version:1,requestId:r.requestId,attempt:r.attempt,state:'running'});
   const timer=setTimeout(()=>{if(entry.state==='running'){entry.state='unknown';entry.error={code:'WAIT_TIMEOUT',message:'Deadline exceeded; cancellation unconfirmed'};}},Math.max(1,r.deadline-Date.now()));
   Promise.resolve().then(()=>execute(r)).then(result=>{if(Date.now()<=r.deadline&&entry.state==='running'){entry.result=result;entry.state='completed';}else{entry.state='unknown';entry.error={code:'WAIT_TIMEOUT',message:'Late result; cancellation unconfirmed'};}},()=>{entry.state='failed';entry.error={code:'EXECUTION_FAILED'};}).finally(()=>{clearTimeout(timer);entry.finished=Date.now();busy=false;});
  });
 }
 return {handler,close(){closed=true;clearInterval(sweep);},get busy(){return busy;}};
}
