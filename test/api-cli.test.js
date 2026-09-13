import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { AutoXBridge } from '../src/bridge.js';
import { fixture, device } from './helpers.js';
const exec = promisify(execFile);
const bin = fileURLToPath(new URL('../bin/autox-bridge.js', import.meta.url));

test('API auth, browser rejection, rebinding defense, malformed body and unknown action', async t => {
  assert.throws(() => new AutoXBridge({ apiHost: '0.0.0.0' }), /token/);
  const { url, client } = await fixture(t, { token: 'secret' });
  assert.equal((await fetch(`${url}/v1/status`)).status, 401);
  assert.equal((await fetch(`${url}/v1/status`, { headers: { authorization: 'Bearer secret', origin: 'http://evil.invalid' } })).status, 401);
  // Fetch overrides Host in some Node versions; use core HTTP for explicit rebinding check.
  const { request } = await import('node:http');
  const status = await new Promise(resolve => {
    request(`${url}/v1/status`, { headers: { authorization: 'Bearer secret', host: 'evil.invalid' } }, r => { r.resume(); resolve(r.statusCode); }).end();
  });
  assert.equal(status, 401);
  assert.equal((await client.request('/v1/status')).started, true);
  const malformed = await fetch(`${url}/v1/action`, { method: 'POST', headers: { authorization: 'Bearer secret', 'content-type': 'application/json' }, body: 'null' });
  assert.equal(malformed.status, 400);
  await assert.rejects(client.action({ action: 'invented' }), /Unknown action/);
  assert.equal((await fetch(`${url}/exec?cmd=rerun&path=x`, { headers: { authorization: 'Bearer secret' } })).status, 404);
});

test('SSE log replay, unicode, live filtering and client cancellation', async t => {
  const { bridge, client } = await fixture(t);
  bridge.publish('log', { deviceId: 'x', data: { log: '历史' } });
  const controller = new AbortController();
  const iterator = client.events({ type: 'log', device: 'x', signal: controller.signal });
  const first = await iterator.next();
  assert.equal(first.value.data.log, '历史');
  const next = iterator.next();
  bridge.publish('log', { deviceId: 'other', data: { log: 'filtered' } });
  bridge.publish('log', { deviceId: 'x', data: { log: '实时🙂' } });
  assert.equal((await next).value.data.log, '实时🙂');
  await iterator.return();
  controller.abort();
});

test('CLI help, version, status, eval, explicit stop id and nonzero JSON errors', async t => {
  const { bridge, url } = await fixture(t);
  const d = await device(t, bridge);
  const run = args => exec(process.execPath, [bin, '--url', url, '--json', ...args], { timeout: 10000 });
  assert.match((await run(['--help'])).stdout, /run-project/);
  assert.equal((await run(['--version'])).stdout.trim(), '0.1.0');
  const status = JSON.parse((await run(['status'])).stdout);
  assert.equal(status.devices, 1);
  const result = JSON.parse((await run(['eval', 'toast("cli")', '--id', 'cli-script'])).stdout);
  assert.equal(result.ok, true);
  assert.deepEqual((await d.next()).data, { command: 'run', id: 'cli-script', name: 'cli-script', script: 'toast("cli")' });
  await run(['stop', 'cli-script', '--exact']);
  assert.equal((await d.next()).data.id, 'cli-script');
  await assert.rejects(run(['stop-all', '--device', 'missing']), error => {
    assert.equal(error.code, 1);
    assert.match(JSON.parse(error.stderr).error, /not found/);
    return true;
  });
});

test('history is bounded and shutdown closes streams/sockets and frees listeners', async t => {
  const { bridge, client } = await fixture(t, { historySize: 3 });
  const d = await device(t, bridge);
  for (let i = 0; i < 10; i++) bridge.publish('custom', { i });
  assert.equal((await client.request('/v1/events')).length, 3);
  const iterator = client.events();
  await iterator.next();
  const closed = once(d.socket, 'close');
  await bridge.stop();
  await closed;
  await iterator.return();
  assert.equal(bridge.started, false);
  assert.equal(bridge.devices.size, 0);
  assert.equal(d.socket.readyState >= 2, true);
  await assert.rejects(bridge.start(), /cannot be restarted/);
});
