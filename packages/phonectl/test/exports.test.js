import test from 'node:test';
import assert from 'node:assert/strict';
import {execute,status,PhoneError} from 'phonectl';
import {createRequire} from 'node:module';
test('published package exports resolve built implementation',()=>{
 assert.equal(typeof execute,'function');assert.equal(typeof status,'function');
 assert.equal(new PhoneError('TEST','message').code,'TEST');
 assert.match(createRequire(import.meta.url).resolve('phonectl'),/dist[/\\]index\.js$/);
});
