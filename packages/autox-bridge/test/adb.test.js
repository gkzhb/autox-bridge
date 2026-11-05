import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { AdbManager } from '../dist/adb.js';
import { fixture } from './helpers.js';

test('ADB device parsing, shell-free args, dynamic forward, hello and owned cleanup', async t => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  t.after(() => { for (const s of server.clients) s.terminate(); return new Promise(resolve => server.close(resolve)); });
  server.on('connection', socket => socket.send(JSON.stringify({ type: 'hello', data: { device_name: 'USB', app_version_code: 629 } })));
  const calls = [];
  const exec = async (file, args, options) => {
    calls.push({ file, args, options });
    if (args[0] === 'devices') return { stdout: 'List of devices attached\nserial1 device product:p model:Pixel\nserial2 unauthorized\n' };
    if (args.includes('tcp:0')) return { stdout: `${server.address().port}\n` };
    return { stdout: '' };
  };
  const { bridge } = await fixture(t, { adb: { executable: '/platform tools/adb', exec } });
  const devices = await bridge.adb.list();
  assert.equal(devices[0].properties.model, 'Pixel');
  assert.equal(devices[1].state, 'unauthorized');
  const [a, b] = await Promise.all([bridge.adb.connect('serial1'), bridge.adb.connect('serial1')]);
  assert.equal(a.id, 'adb:serial1');
  assert.equal(a.id, b.id);
  assert.equal(a.transport, 'adb');
  assert.equal(calls.filter(c => c.args.includes('tcp:0')).length, 1);
  assert.deepEqual(calls.find(c => c.args.includes('tcp:0')).args, ['-s', 'serial1', 'forward', 'tcp:0', 'tcp:9317']);
  await bridge.stop();
  assert.ok(calls.some(c => c.args.includes('--remove')));
  assert.ok(calls.every(c => c.file === '/platform tools/adb' && !c.options.shell));
});

test('ADB failure removes its mapping; tracking missing executable fails loudly', async () => {
  const calls = [];
  const bridge = { devices: new Map(), connect: async () => { throw new Error('unavailable'); }, publish() {} };
  const adb = new AdbManager(bridge, { exec: async (_file, args) => { calls.push(args); return { stdout: args.includes('tcp:0') ? '12345' : '' }; } });
  await assert.rejects(adb.connect('serial'), /unavailable/);
  assert.equal(adb.forwards.size, 0);
  assert.deepEqual(calls[1], ['-s', 'serial', 'forward', '--remove', 'tcp:12345']);
  await assert.rejects(adb.connect('-bad'), /serial/);
  const missing = new AdbManager(bridge, { exec: async () => { throw new Error('ENOENT'); } });
  await assert.rejects(missing.track(), /ENOENT/);
  assert.equal(missing.tracking, false);
});
