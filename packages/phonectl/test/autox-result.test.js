import test from 'node:test';
import assert from 'node:assert/strict';
import {awaitResult} from '../dist/autox-result.js';

const missing=()=>Object.assign(new Error('not yet published'),{code:'ENOENT'});

test('result watcher rechecks a rename notification delivered during an earlier missing-file read',async()=>{
 let notify,finishFirst,reads=0,closed=0;
 const first=new Promise((_,reject)=>{finishFirst=()=>reject(missing());});
 const awaited=awaitResult({
  subscribe(fn){notify=fn;return()=>{closed++;};},
  read(){reads++;return reads===1?first:Promise.resolve({requestId:'fixed-request',exitCode:7});}
 },Date.now()+200);
 // First read is in flight. The publisher atomically renames result.tmp to
 // result.json and the only notification arrives before ENOENT is delivered.
 notify();finishFirst();
 assert.deepEqual(await awaited.result,{requestId:'fixed-request',exitCode:7});
 assert.equal(reads,2);assert.equal(closed,1);
});

test('result watcher checks pre-existing publication and ignores completion after deadline',async()=>{
 let closed=0;
 const present=awaitResult({subscribe(){return()=>{closed++;};},read:async()=>({exitCode:0})},Date.now()+200);
 assert.equal((await present.result).exitCode,0);assert.equal(closed,1);
 let finish;
 const late=awaitResult({subscribe(){return()=>{};},read:()=>new Promise(resolve=>{finish=resolve;})},Date.now()-1);
 await assert.rejects(late.result,e=>e.code==='AUTOX_TIMEOUT');
 finish({exitCode:0});
});

test('result watcher fails closed on subscription errors instead of waiting for timeout',async()=>{
 let fail,finish;
 const awaited=awaitResult({subscribe(_,onError){fail=onError;return()=>{};},read:()=>new Promise(resolve=>{finish=resolve;})},Date.now()+200);
 fail(Object.assign(new Error('filesystem watcher unavailable'),{code:'EIO'}));
 await assert.rejects(awaited.result,e=>e.code==='EIO');finish({exitCode:0});
});
