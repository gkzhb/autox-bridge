import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import WebSocket from 'ws';
import { AutoXBridge } from '../dist/bridge.js';
import { DeviceSession } from '../dist/protocol.js';
import { AdbManager } from '../dist/adb.js';
import { createProject, packageProject } from '../dist/project.js';
import { fixture, device } from './helpers.js';

function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }

test('R1: concurrent start deduplicates; immediate stop leaves no listeners', async t => {
  const bridge = new AutoXBridge({ port: 0, apiPort: 0 });
  t.after(() => bridge.stop());
  const a = bridge.start(), b = bridge.start();
  assert.equal(a, b);
  await a;
  await bridge.stop();
  assert.equal(bridge.deviceServer.listening, false);
  assert.equal(bridge.apiServer.listening, false);
  const racing = new AutoXBridge({ port: 0, apiPort: 0 });
  await Promise.allSettled([racing.start(), racing.stop()]);
  assert.equal(racing.started, false);
  assert.equal(racing.deviceServer.listening, false);
  assert.equal(racing.apiServer.listening, false);
});

test('R2/R3: shutdown rejects new sessions; arbitrary browser origins cannot attach', async t => {
  const { bridge } = await fixture(t);
  const url = `ws://127.0.0.1:${bridge.deviceAddress.port}`;
  const browser = new WebSocket(url, { origin: 'https://evil.invalid' });
  await assert.rejects(once(browser, 'open'), /401|403/);
  assert.equal(bridge.devices.size, 0);
  const gate = deferred();
  bridge.adb.close = () => gate.promise;
  const stopping = bridge.stop();
  const socket = new WebSocket(url);
  await assert.rejects(once(socket, 'open'), /ECONNREFUSED|401|403|hang up|reset/i);
  gate.resolve(); await stopping;
});

test('R4: SSE replays logs larger than stream high-water mark in order', async t => {
  const { bridge, client } = await fixture(t);
  const large = '字'.repeat(50000);
  for (let i = 0; i < 5; i++) bridge.publish('log', { deviceId: 'x', data: { log: large, i } });
  const iterator = client.events({ type: 'log' });
  for (let i = 0; i < 5; i++) {
    const { value } = await iterator.next();
    assert.equal(value.data.i, i); assert.equal(value.data.log, large);
  }
  await iterator.return();
});

test('R5: ADB concurrent tracking deduplicates and untrack cancels pending validation', async () => {
  const bridge = { devices: new Map(), publish() {} };
  const gate = deferred(); let calls = 0;
  const adb = new AdbManager(bridge, { exec: async () => { calls++; await gate.promise; return { stdout: 'List of devices attached\n' }; } });
  const a = adb.track(), b = adb.track();
  assert.equal(a, b); assert.equal(calls, 1);
  adb.untrack(); gate.resolve();
  assert.deepEqual(await a, { tracking: false });
  assert.equal(adb.tracking, false);
  await adb.track();
  await adb.scanTask;
  assert.equal(adb.tracking, true);
  await adb.close();
});

test('R6: failed ADB removals retain ownership for retry; close awaits in-flight cleanup', async () => {
  const bridge = { devices: new Map(), publish() {} };
  let calls = 0;
  const adb = new AdbManager(bridge, { exec: async () => { if (++calls === 1) throw new Error('temporary'); return { stdout: '' }; } });
  adb.forwards.set('s', 1234);
  await adb.removeForward('s');
  assert.equal(adb.forwards.get('s'), 1234);
  await adb.close();
  assert.equal(adb.forwards.size, 0);
  assert.equal(calls, 2);
  const gate = deferred(); let finished = false;
  const other = new AdbManager(bridge, { exec: async () => { await gate.promise; return { stdout: '' }; } });
  other.forwards.set('s', 1234);
  const removal = other.removeForward('s');
  const closing = other.close().then(() => { finished = true; });
  await delay(10);
  assert.equal(finished, false);
  gate.resolve(); await removal; await closing;
  assert.equal(finished, true);
});

test('R7: close deadline is independent of stalled send and is idempotent', async () => {
  class Socket extends EventEmitter {
    readyState = WebSocket.OPEN;
    bufferedAmount = 0;
    send() {}
    close() {}
    terminate() { this.readyState = WebSocket.CLOSED; this.emit('close', 1006, Buffer.alloc(0)); }
  }
  const socket = new Socket();
  const session = new DeviceSession(socket, { heartbeatInterval: 0 });
  const closing = session.close();
  assert.equal(closing, session.close());
  // Keep the test process alive independently of unref'ed lifecycle deadlines.
  await Promise.race([closing, delay(1200).then(() => { throw new Error('close deadline missing'); })]);
  assert.equal(socket.readyState, WebSocket.CLOSED);
});

test('R8/R9: legacy file URI stopAll/run and explicit reference file-selection mode', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-autox-regression-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await createProject(root);
  await fs.mkdir(path.join(root, 'node_modules'));
  await fs.writeFile(path.join(root, 'node_modules', 'runtime.js'), 'runtime');
  await fs.writeFile(path.join(root, 'build-extra.js'), 'extra');
  const safe = await packageProject(root);
  assert.equal(safe.files.includes('node_modules/runtime.js'), false);
  assert.equal(safe.files.includes('build-extra.js'), true);
  const reference = await packageProject(root, undefined, { referenceFiles: true });
  assert.equal(reference.files.includes('node_modules/runtime.js'), true);
  assert.equal(reference.files.includes('build-extra.js'), false);
  const { bridge, url } = await fixture(t, { legacyExec: true });
  const d = await device(t, bridge);
  const response = fetch(`${url}/exec?${new URLSearchParams({ cmd: 'rerun', path: pathToFileURL(path.join(root, 'main.js')).href })}`);
  assert.equal((await d.next()).data.command, 'stopAll');
  const run = await d.next();
  assert.equal(run.data.command, 'run');
  assert.equal(run.data.id, path.join(root, 'main.js'));
  assert.equal((await response).status, 200);
});
