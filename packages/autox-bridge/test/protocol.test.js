import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { fixture, device, inbox } from './helpers.js';

const md5 = b => createHash('md5').update(b).digest('hex');

test('modern/legacy hello, repeated hello, ping echo, log and name update', async t => {
  const { bridge, client } = await fixture(t);
  const modern = await device(t, bridge);
  assert.equal(modern.reply.type, 'hello');
  assert.equal(modern.reply.data, 'ok');
  assert.equal(modern.reply.version, '1.110.0');
  assert.equal(modern.reply.debug, false);
  assert.equal(typeof modern.reply.message_id, 'string');
  modern.socket.send(JSON.stringify({ type: 'hello', data: { device_name: 'again', app_version_code: 629 } }));
  await modern.next();
  assert.equal(bridge.devices.size, 1);
  modern.socket.send(JSON.stringify({ type: 'ping', data: { token: [1, '二'] } }));
  assert.deepEqual(await modern.next(), { type: 'pong', data: { token: [1, '二'] } });
  const gotLog = new Promise(resolve => bridge.on('event', event => { if (event.type === 'log') resolve(event); }));
  modern.socket.send(JSON.stringify({ type: 'log', data: { log: '你好 Android' } }));
  assert.equal((await gotLog).data.log, '你好 Android');
  const logs = await client.request('/v1/events?type=log');
  assert.equal(logs[0].deviceId, modern.id);
  const updated = new Promise(resolve => bridge.on('event', event => { if (event.type === 'device_updated') resolve(event); }));
  modern.socket.send(JSON.stringify({ type: 'device_name', data: 'Renamed' }));
  await updated;
  assert.equal((await client.request('/v1/devices'))[0].name, 'Renamed');
  const legacy = await device(t, bridge, { version: 628 });
  assert.equal(legacy.reply.data, '连接成功');
  assert.equal('version' in legacy.reply, false);
});

test('run/rerun/save/stop/stopAll exact envelopes and multi-device safety', async t => {
  const { bridge, client } = await fixture(t);
  await assert.rejects(client.action({ action: 'stopAll' }), /No AutoX devices/);
  const one = await device(t, bridge, { name: 'one' });
  for (const action of ['run', 'rerun', 'save', 'stop', 'stopAll']) {
    const input = { action, id: '/scripts/hello.js', name: 'hello.js', script: 'toast("好")' };
    const result = await client.action(input);
    const message = await one.next();
    const expected = action === 'stopAll' ? { command: action } : action === 'stop' ? { command: action, id: input.id }
      : { command: action, id: input.id, name: input.name, script: input.script };
    assert.equal(message.type, 'command');
    assert.deepEqual(message.data, expected);
    assert.equal(result.results[0].messageId, message.message_id);
    assert.equal(result.results[0].status, 'sent');
  }
  const two = await device(t, bridge, { name: 'two' });
  await assert.rejects(client.action({ action: 'stopAll' }), /Multiple devices/);
  await assert.rejects(client.action({ action: 'stopAll', device: 'one', all: true }), /either/);
  await client.action({ action: 'stopAll', device: 'two' });
  assert.equal((await two.next()).data.command, 'stopAll');
  const broadcast = await client.action({ action: 'stopAll', all: true });
  assert.equal(broadcast.results.length, 2);
  await one.next(); await two.next();
});

test('malformed messages do not crash, unknown messages remain observable, hello timeout', async t => {
  const { bridge, client } = await fixture(t, { handshakeTimeout: 150 });
  const pending = await device(t, bridge, { hello: false });
  const closed = once(pending.socket, 'close');
  pending.socket.send('not json');
  pending.socket.send(JSON.stringify({ type: 'hello', data: null }));
  await closed;
  assert.equal(bridge.devices.size, 0);
  assert.ok((await client.request('/v1/events?type=warning')).length >= 2);
  const valid = await device(t, bridge);
  const seen = new Promise(resolve => bridge.on('event', event => { if (event.message?.type === 'custom') resolve(event); }));
  valid.socket.send(JSON.stringify({ type: 'custom', data: { result: 42 } }));
  assert.equal((await seen).message.data.result, 42);
});

test('raw envelope, binary MD5 frame order, and protocol close', async t => {
  const { bridge, client } = await fixture(t);
  const d = await device(t, bridge);
  await client.action({ action: 'raw', message: { type: 'custom', data: [1] } });
  assert.equal((await d.next()).type, 'custom');
  const bytes = Buffer.from('zip-compatible arbitrary binary\x00');
  await client.action({ action: 'bytes', command: 'custom_bytes', base64: bytes.toString('base64'), data: { id: 'x' } });
  assert.deepEqual(await d.next(), bytes);
  const message = await d.next();
  assert.equal(message.type, 'bytes_command');
  assert.equal(message.md5, md5(bytes));
  assert.deepEqual(message.data, { command: 'custom_bytes', id: 'x' });
  const closed = once(d.socket, 'close');
  await client.action({ action: 'disconnect' });
  assert.equal((await d.next()).type, 'close');
  await closed;
});

test('outbound WS client supports device-server hello-first flow and duplicate connect', async t => {
  const { bridge } = await fixture(t);
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  t.after(() => { for (const socket of server.clients) socket.terminate(); return new Promise(resolve => server.close(resolve)); });
  let next;
  server.on('connection', socket => {
    next = inbox(socket);
    socket.send(JSON.stringify({ type: 'hello', data: { device_name: 'server', app_version_code: 700 } }));
  });
  const url = `ws://127.0.0.1:${server.address().port}`;
  const [a, b] = await Promise.all([bridge.connect(url), bridge.connect(url)]);
  assert.equal(a.id, b.id);
  assert.equal(a.transport, 'direct');
  assert.equal((await next()).data, 'ok');
  await bridge.execute({ action: 'stopAll', device: a.id });
  assert.equal((await next()).data.command, 'stopAll');
});
