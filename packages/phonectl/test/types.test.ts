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
void [result,observed,PhoneError];
