import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { BridgeClient } from '../src/client.js';
const bin = fileURLToPath(new URL('../bin/autox-bridge.js', import.meta.url));

test('foreground serve supports status and API shutdown, with secrets absent from help', { timeout: 15000 }, async t => {
  const processChild = spawn(process.execPath, [bin, '--json', 'serve', '--port', '0', '--api-port', '0'], {
    env: { ...process.env, AUTOX_BRIDGE_TOKEN: 'smoke-secret' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => processChild.kill('SIGKILL'));
  let stderr = '';
  processChild.stderr.on('data', chunk => { stderr += chunk; });
  const exited = once(processChild, 'exit');
  const lines = createInterface({ input: processChild.stdout });
  const [line] = await once(lines, 'line');
  const status = JSON.parse(line);
  const client = new BridgeClient({ url: `http://127.0.0.1:${status.apiAddress.port}`, token: 'smoke-secret' });
  assert.equal((await client.request('/v1/status')).started, true);
  assert.deepEqual(await client.action({ action: 'shutdown' }), { stopping: true });
  assert.deepEqual(await exited, [0, null], stderr);
});

test('foreground serve handles SIGTERM and port collision exits nonzero', { timeout: 15000 }, async t => {
  const child = spawn(process.execPath, [bin, '--json', 'serve', '--port', '0', '--api-port', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGKILL'));
  const exited = once(child, 'exit');
  const lines = createInterface({ input: child.stdout });
  const [line] = await once(lines, 'line');
  const status = JSON.parse(line);
  const collision = spawn(process.execPath, [bin, '--json', 'serve', '--port', String(status.deviceAddress.port), '--api-port', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => collision.kill('SIGKILL'));
  let error = '';
  collision.stderr.on('data', chunk => { error += chunk; });
  const [code] = await once(collision, 'exit');
  assert.equal(code, 1); assert.match(error, /EADDRINUSE/);
  child.kill('SIGTERM');
  assert.deepEqual(await exited, [0, null]);
});
