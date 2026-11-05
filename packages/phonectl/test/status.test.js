import test from 'node:test';
import assert from 'node:assert/strict';
import { status } from '../dist/index.js';
import {mkdtemp,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
test('status observes only and reports unknown rather than assuming backend availability', async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'phonectl-status-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const sentinel=path.join(dir,'executed');const rish=path.join(dir,'rish');await writeFile(rish,`#!/bin/sh\necho bad > '${sentinel}'\n`,{mode:0o700});
 const result=await status({rishPath:rish,androidBin:path.join(dir,'missing')});
 assert.equal(result.rish.present,true);assert.equal(result.rish.authorized,'unknown');assert.equal(result.autox.running,'unknown');assert.equal(result.autox.installed,'unknown');
 assert.equal(result.device.model,null);assert.equal(result.termux.uid,process.getuid());assert.equal(result.readOnly,true);
 assert.deepEqual((await readdir(dir)).sort(),['rish']);
});
test('status collects observable device/package facts from bounded OS commands',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'phonectl-status-os-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 await writeFile(path.join(dir,'getprop'),'#!/bin/sh\ncase "$1" in ro.product.model) echo V1986A;; ro.build.version.release) echo 12;; esac\n',{mode:0o700});
 await writeFile(path.join(dir,'pm'),'#!/bin/sh\nprintf "package:/test/base.apk\\n"\n',{mode:0o700});
 const result=await status({androidBin:dir,rishPath:path.join(dir,'missing')});
 assert.equal(result.device.model,'V1986A');assert.equal(result.device.android,'12');assert.equal(result.autox.installed,true);assert.equal(result.rish.present,false);assert.equal(result.rish.authorized,'unknown');
});
