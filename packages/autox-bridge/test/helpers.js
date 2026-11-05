import { once } from 'node:events';
import WebSocket from 'ws';
import { AutoXBridge } from '../dist/bridge.js';
import { BridgeClient } from '../dist/client.js';

export async function fixture(t, options = {}) {
  const bridge = new AutoXBridge({ port: 0, apiPort: 0, heartbeatInterval: 0, ...options });
  await bridge.start();
  t.after(() => bridge.stop());
  const url = `http://127.0.0.1:${bridge.apiAddress.port}`;
  return { bridge, url, client: new BridgeClient({ url, token: options.token ?? '' }) };
}
export function inbox(socket) {
  const messages = [];
  const waiters = [];
  socket.on('message', (data, binary) => {
    const value = binary ? Buffer.from(data) : JSON.parse(data.toString());
    if (waiters.length) waiters.shift()(value); else messages.push(value);
  });
  return () => messages.length ? Promise.resolve(messages.shift()) : new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for mock device frame')), 3000);
    waiters.push(value => { clearTimeout(timer); resolve(value); });
  });
}
export async function device(t, bridge, { name = 'Pixel', version = 629, hello = true } = {}) {
  const socket = new WebSocket(`ws://127.0.0.1:${bridge.deviceAddress.port}`);
  t.after(() => socket.terminate());
  const next = inbox(socket);
  await once(socket, 'open');
  if (!hello) return { socket, next };
  const attached = new Promise((resolve, reject) => {
    const listener = event => {
      if (event.type === 'device_attached') { clearTimeout(timer); bridge.off('event', listener); resolve(event); }
    };
    const timer = setTimeout(() => { bridge.off('event', listener); reject(new Error('Mock device attach timed out')); }, 3000);
    bridge.on('event', listener);
  });
  socket.send(JSON.stringify({ type: 'hello', data: { device_name: name, app_version_code: version } }));
  const reply = await next();
  const event = await attached;
  return { socket, next, reply, id: event.device.id };
}
