import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { AutoXBridge, BridgeClient, BridgeError } from 'autox-bridge';
import { envelope, DeviceSession } from 'autox-bridge/protocol';

const require = createRequire(import.meta.url);

test('package exports resolve built ESM for import and CommonJS resolution', () => {
  assert.equal(typeof AutoXBridge, 'function');
  assert.equal(typeof BridgeClient, 'function');
  assert.equal(typeof DeviceSession, 'function');
  assert.equal(new BridgeError('bad input', 422).status, 422);
  assert.equal(envelope('ping', null).type, 'ping');
  assert.match(require.resolve('autox-bridge'), /dist[/\\]index\.js$/);
  assert.match(require.resolve('autox-bridge/protocol'), /dist[/\\]protocol\.js$/);
});
