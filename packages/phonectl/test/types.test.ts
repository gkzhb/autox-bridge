import {execute,status,PhoneError} from 'phonectl';
import type {ExecResult,ExecOptions,StatusOptions} from 'phonectl';
const opts:ExecOptions={as:'termux',argv:['id']};
const result:Promise<ExecResult>=execute(opts);
const statusOpts:StatusOptions={};
const observed=status(statusOpts);
// @ts-expect-error no implicit root identity
execute({as:'root',argv:['id']});
// @ts-expect-error argv is mandatory
execute({as:'termux'});
const automatic:ExecOptions={as:'shell',backend:'auto',argv:['id']};
const explicitRish:ExecOptions={as:'shell',backend:'rish',argv:['id']};
const legacyHttp:ExecOptions={as:'shell',backend:'autox-http',argv:['id']};
function actualBackend(r:ExecResult){const backend:ExecResult['backend']=r.backend;const reason:string|undefined=r.fallback?.reason;return [backend,reason];}
void [result,observed,PhoneError,automatic,explicitRish,legacyHttp,actualBackend];
