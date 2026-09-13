import { EventEmitter } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { promises as fs } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import WebSocket, { WebSocketServer } from 'ws';
import { DeviceSession, envelope, MAX_PAYLOAD, isRecord } from './protocol.js';
import { packageProject } from './project.js';
import { AdbManager } from './adb.js';
import type { AdbOptions } from './adb.js';
import type { ActionResponse, ActionResponseFor, BridgeAction, BridgeEvent, BridgeStatus, CommandResult, CommandResponse, DeviceInfo, DeviceSessionOptions, JsonObject, ProtocolMessage, PublishEventData, TargetSelection } from './types.js';
import { BridgeError, errorMessage } from './errors.js';

export interface BridgeOptions {
  host?: string; port?: number; apiHost?: string; apiPort?: number; token?: string;
  handshakeTimeout?: number; heartbeatInterval?: number; historySize?: number;
  legacyExec?: boolean; compatVersion?: string; adb?: AdbOptions;
}
type ResolvedBridgeOptions = Required<Omit<BridgeOptions, 'compatVersion' | 'adb'>> & Pick<BridgeOptions, 'compatVersion' | 'adb'>;

const loopback = (host: string) => ['127.0.0.1', '::1', 'localhost'].includes(host);
function fail(message: string, status = 400): never { throw new BridgeError(message, status); }
function text(value: unknown, name: string): string { if (typeof value !== 'string' || !value) fail(`${name} must be a non-empty string`); return value; }
function equal(a: string, b: string) { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); }
function listen(server: http.Server, port: number, host: string): Promise<AddressInfo> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => { server.off('listening', onListen); reject(error); };
    const onListen = () => { server.off('error', onError); resolve(server.address() as AddressInfo); };
    server.once('error', onError); server.once('listening', onListen); server.listen(port, host);
  });
}
function stopServer(server?: http.Server): Promise<void> {
  return new Promise<void>(resolve => { if (!server?.listening) return resolve(); server.close(() => resolve()); server.closeAllConnections(); });
}
async function bodyJson(request: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_PAYLOAD) fail('Request exceeds 64 MiB', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString()); }
  catch { fail('Invalid JSON request body'); }
}

export class AutoXBridge extends EventEmitter<{ event: [BridgeEvent]; stopped: [] }> {
  options: ResolvedBridgeOptions;
  devices: Map<string, DeviceSession>;
  sessions: Set<DeviceSession>;
  connecting: Map<string, Promise<DeviceInfo>>;
  outbound: Set<WebSocket>;
  events: BridgeEvent[];
  eventBytes: number;
  eventId: number;
  streams: Set<http.ServerResponse>;
  adb: AdbManager;
  started: boolean;
  stopping: boolean;
  startPromise?: Promise<BridgeStatus>;
  stopPromise?: Promise<void>;
  deviceServer?: http.Server;
  apiServer?: http.Server;
  wsServer?: WebSocketServer;
  deviceAddress?: AddressInfo;
  apiAddress?: AddressInfo;

  constructor(options: BridgeOptions = {}) {
    super();
    this.options = { host: '127.0.0.1', port: 9317, apiHost: '127.0.0.1', apiPort: 9318,
      token: '', handshakeTimeout: 10000, heartbeatInterval: 10000, historySize: 1000,
      legacyExec: false, ...options };
    if (!loopback(this.options.apiHost) && !this.options.token) throw new Error('Non-loopback API binding requires a bearer token');
    for (const key of ['port', 'apiPort'] as const) {
      if (!Number.isInteger(this.options[key]) || this.options[key] < 0 || this.options[key] > 65535) throw new Error(`Invalid ${key}`);
    }
    if (!Number.isInteger(this.options.historySize) || this.options.historySize < 0 || this.options.historySize > 10000) throw new Error('historySize must be 0..10000');
    this.devices = new Map();
    this.sessions = new Set();
    this.connecting = new Map();
    this.outbound = new Set();
    this.events = [];
    this.eventBytes = 0;
    this.eventId = 0;
    this.streams = new Set();
    this.adb = new AdbManager(this, options.adb);
    this.started = false;
    this.stopping = false;
  }

  publish(type: string, data: PublishEventData = {}): BridgeEvent {
    const event: BridgeEvent = { sequence: ++this.eventId, timestamp: new Date().toISOString(), type, ...data };
    // Bound both count and bytes. Huge raw/binary payloads are represented by metadata upstream.
    const size = Buffer.byteLength(JSON.stringify(event));
    if (size <= 1024 * 1024) {
      this.events.push(event); this.eventBytes += size;
      while (this.events.length > this.options.historySize || this.eventBytes > 8 * 1024 * 1024) {
        this.eventBytes -= Buffer.byteLength(JSON.stringify(this.events.shift()!));
      }
    }
    this.emit('event', event);
    return event;
  }

  attach(socket: WebSocket, options: DeviceSessionOptions = {}) {
    if (this.stopping) { socket.terminate(); throw new Error('Bridge is shutting down'); }
    const session = new DeviceSession(socket, { ...this.options, ...options });
    this.sessions.add(session);
    session.on('attach', () => {
      const old = this.devices.get(session.id);
      if (old && old !== session) void old.close();
      this.devices.set(session.id, session);
      this.publish('device_attached', { device: session.info() });
    });
    session.on('disconnect', details => {
      this.sessions.delete(session);
      if (this.devices.get(session.id) === session) {
        this.devices.delete(session.id);
        this.publish('device_detached', { deviceId: session.id, ...details });
        if (session.transport === 'adb') void this.adb.removeForward(session.id.slice(4));
      }
    });
    session.on('warning', error => this.publish('warning', { deviceId: session.id, message: errorMessage(error) }));
    session.on('log', data => this.publish('log', { deviceId: session.id, data }));
    session.on('update', device => this.publish('device_updated', { device }));
    session.on('message', message => {
      const size = Buffer.byteLength(JSON.stringify(message));
      this.publish('message', size > 1024 * 1024
        ? { deviceId: session.id, messageType: message.type, bytes: size, truncated: true }
        : { deviceId: session.id, message });
    });
    session.on('binary', bytes => this.publish('binary', { deviceId: session.id, bytes: Array.isArray(bytes) ? bytes.reduce((size, chunk) => size + chunk.length, 0) : bytes instanceof ArrayBuffer ? bytes.byteLength : bytes.length }));
    return session;
  }

  start() {
    if (this.stopping) return Promise.reject(new Error('A stopped bridge cannot be restarted; create a new instance'));
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startOnce();
    return this.startPromise;
  }

  async startOnce() {
    this.deviceServer = http.createServer((_request, response) => {
      response.writeHead(404); response.end('AutoX WebSocket endpoint; management API uses a separate port.\n');
    });
    this.wsServer = new WebSocketServer({ server: this.deviceServer, maxPayload: MAX_PAYLOAD, perMessageDeflate: false,
      verifyClient: ({ req }: { req: http.IncomingMessage }) => {
        if (this.stopping || req.headers.origin) return false;
        if (!loopback(this.options.host)) return true;
        try { return loopback(new URL(`http://${req.headers.host}`).hostname.replace(/^\[|\]$/g, '')); }
        catch { return false; }
      },
    });
    this.wsServer.on('connection', (socket, request) => {
      if (this.stopping) { socket.terminate(); return; }
      this.attach(socket, { transport: 'tcp', address: `${request.socket.remoteAddress}:${request.socket.remotePort}` });
    });
    this.wsServer.on('error', error => this.publish('warning', { message: error.message }));
    this.apiServer = http.createServer((request, response) => {
      this.handleHttp(request, response).catch((error: unknown) => {
        if (!response.headersSent && !response.destroyed) this.json(response, error instanceof BridgeError ? error.status : 500, { error: errorMessage(error) });
        else response.destroy();
      });
    });
    for (const server of [this.deviceServer, this.apiServer]) {
      server.requestTimeout = 30000;
      server.headersTimeout = 10000;
      server.on('error', error => this.publish('warning', { message: error.message }));
    }
    try {
      this.deviceAddress = await listen(this.deviceServer, this.options.port, this.options.host);
      if (this.stopping) throw new Error('Bridge stopped during startup');
      this.apiAddress = await listen(this.apiServer, this.options.apiPort, this.options.apiHost);
      if (this.stopping) throw new Error('Bridge stopped during startup');
      this.started = true;
      this.publish('bridge_started', { status: this.status() });
      return this.status();
    } catch (error) {
      this.stopping = true;
      for (const session of this.sessions) session.socket.terminate();
      await Promise.all([stopServer(this.apiServer), stopServer(this.deviceServer)]);
      await new Promise<void>(resolve => this.wsServer!.close(() => resolve()));
      throw error;
    }
  }

  status(): BridgeStatus {
    const ips = Object.values(os.networkInterfaces()).flat().filter((x): x is os.NetworkInterfaceInfo => !!x && !x.internal && x.family === 'IPv4').map(x => x.address);
    return { started: this.started, pid: process.pid, deviceAddress: this.deviceAddress,
      apiAddress: this.apiAddress, devices: this.devices.size, adbTracking: this.adb.tracking,
      deviceUrls: (loopback(this.options.host) ? [this.options.host] : ips).map(ip => `ws://${ip.includes(':') ? `[${ip}]` : ip}:${this.deviceAddress?.port ?? this.options.port}`) };
  }

  select({ device, all = false }: TargetSelection = {}) {
    if (device && all) fail('Use either device or all, not both');
    if (typeof all !== 'boolean') fail('all must be boolean');
    const devices = [...this.devices.values()].filter(d => d.attached);
    if (device) {
      text(device, 'device');
      const exact = devices.find(d => d.id === device);
      const matches = exact ? [exact] : devices.filter(d => d.name === device);
      if (matches.length !== 1) fail(matches.length ? 'Device name is ambiguous; use its id' : `Device not found: ${device}`, 404);
      return matches;
    }
    if (!devices.length) fail('No AutoX devices connected', 409);
    if (!all && devices.length > 1) fail('Multiple devices connected; specify --device or --all', 409);
    return all ? devices : [devices[0]];
  }

  connect(url: string, options: DeviceSessionOptions = {}): Promise<DeviceInfo> {
    let parsed;
    try { parsed = new URL(url); } catch { return Promise.reject(new Error('Invalid WebSocket URL')); }
    if (!['ws:', 'wss:'].includes(parsed.protocol) || parsed.username || parsed.password) return Promise.reject(new Error('Expected ws:// or wss:// URL without credentials'));
    const id = options.id ?? `ws:${parsed.href}`;
    if (this.stopping) return Promise.reject(new Error('Bridge is shutting down'));
    const existing = this.devices.get(id);
    if (existing) return Promise.resolve(existing.info());
    if (this.connecting.has(id)) return this.connecting.get(id)!;
    const promise = new Promise<DeviceInfo>((resolve, reject) => {
      const socket = new WebSocket(parsed, { handshakeTimeout: this.options.handshakeTimeout, maxPayload: MAX_PAYLOAD, perMessageDeflate: false });
      this.outbound.add(socket);
      socket.once('close', () => this.outbound.delete(socket));
      socket.once('error', reject);
      socket.once('open', () => {
        try {
          const session = this.attach(socket, { ...options, id, transport: options.transport ?? 'direct', address: parsed.href });
          session.ready.then(s => resolve(s.info()), reject);
        } catch (error) { socket.terminate(); reject(error); }
      });
    }).finally(() => this.connecting.delete(id));
    this.connecting.set(id, promise);
    return promise;
  }

  execute<T extends BridgeAction>(input: T): Promise<ActionResponseFor<T>> {
    return this.executeInput(input) as Promise<ActionResponseFor<T>>;
  }

  /** HTTP JSON is untrusted; retain runtime validation independently of the public TS API. */
  private async executeInput(input: unknown): Promise<ActionResponse> {
    if (!isRecord(input)) fail('Request must be a JSON object');
    if (this.stopping) fail('Bridge is shutting down', 503);
    const { action } = input;
    switch (action) {
      case 'connect': return this.connect(text(input.url, 'url'));
      case 'adb-list': return this.adb.list();
      case 'adb-connect': return this.adb.connect(text(input.serial, 'serial'));
      case 'adb-track': return this.adb.track();
      case 'adb-untrack': return this.adb.untrack();
      case 'shutdown': setImmediate(() => { void this.stop(); }); return { stopping: true };
    }
    const commands = ['run', 'rerun', 'save', 'stop', 'stopAll', 'run_project', 'save_project', 'disconnect', 'raw', 'bytes'];
    if (typeof action !== 'string' || !commands.includes(action)) fail(`Unknown action: ${action}`);
    const targets = this.select({ device: input.device as string | undefined, all: input.all as boolean | undefined });
    let commandData: JsonObject | undefined, projectFolder: string | undefined;
    if (['run', 'rerun', 'save'].includes(action)) {
      const id = text(input.id, 'id');
      if (typeof input.script !== 'string') fail('script must be a string');
      commandData = { id, name: input.name ?? id, script: input.script };
      text(commandData.name, 'name');
    } else if (action === 'stop') commandData = { id: text(input.id, 'id') };
    else if (action === 'stopAll') commandData = {};
    else if (action.endsWith('_project')) projectFolder = await fs.realpath(text(input.folder, 'folder'));
    else if (action === 'raw') {
      if (!isRecord(input.message) || typeof input.message.type !== 'string') fail('message must be an object with a type');
    } else if (action === 'bytes') {
      text(input.command, 'command');
      const base64 = text(input.base64, 'base64');
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) fail('Invalid base64 data');
      if (input.data !== undefined && !isRecord(input.data)) fail('data must be an object');
    }
    // Capture validated extension payloads before entering asynchronous per-device queues.
    const rawMessage = input.message as ProtocolMessage;
    const base64 = input.base64 as string;
    const bytesData = input.data as JsonObject | undefined;
    const results = await Promise.all(targets.map(async (session): Promise<CommandResult> => {
      try {
        return await session.enqueue<CommandResult>(async () => {
          if (action === 'disconnect') { await session.close(); return { deviceId: session.id, status: 'close_sent' }; }
          let message: ProtocolMessage, extra: JsonObject = {};
          if (projectFolder) {
            const transfer = await packageProject(projectFolder, session.projects.get(projectFolder), { full: input.full === true, referenceFiles: input.referenceFiles === true });
            message = { ...envelope('bytes_command', { command: action, id: projectFolder, name: projectFolder }), md5: transfer.md5 };
            await session.send(transfer.buffer, true);
            await session.sendJson(message);
            session.projects.set(projectFolder, transfer.snapshot);
            extra = { files: transfer.files, removed: transfer.removed, bytes: transfer.buffer.length, md5: transfer.md5,
              ...(transfer.removed.length ? { warning: 'Protocol cannot delete remote files; removed files remain on device' } : {}) };
          } else if (action === 'raw') {
            message = { ...rawMessage, message_id: rawMessage.message_id ?? envelope('', null).message_id };
            await session.sendJson(message);
          } else if (action === 'bytes') {
            const { createHash } = await import('node:crypto');
            const bytes = Buffer.from(base64, 'base64');
            message = { ...envelope('bytes_command', { ...bytesData, command: input.command }), md5: createHash('md5').update(bytes).digest('hex') };
            await session.send(bytes, true);
            await session.sendJson(message);
            extra = { md5: message.md5, bytes: bytes.length };
          } else {
            message = envelope('command', { ...commandData, command: action });
            await session.sendJson(message);
          }
          const result: CommandResult = { deviceId: session.id, status: 'sent', messageId: message.message_id, ...extra };
          this.publish('command_sent', { action, ...result });
          return result;
        });
      } catch (error) { return { deviceId: session.id, status: 'error', error: errorMessage(error) }; }
    }));
    return { results, ok: results.every(result => result.status !== 'error') };
  }

  authorized(request: http.IncomingMessage) {
    // CORS is intentionally absent, and browser-origin requests are denied even on loopback.
    if (request.headers.origin) return false;
    const host = request.headers.host;
    if (loopback(this.options.apiHost)) {
      let hostname;
      try { hostname = new URL(`http://${host}`).hostname.replace(/^\[|\]$/g, ''); } catch { return false; }
      if (!loopback(hostname)) return false; // DNS rebinding defense
    }
    return !this.options.token || equal(request.headers.authorization ?? '', `Bearer ${this.options.token}`);
  }

  json(response: http.ServerResponse, status: number, value: unknown) {
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    response.end(JSON.stringify(value) + '\n');
  }

  async handleHttp(request: http.IncomingMessage, response: http.ServerResponse) {
    if (!this.authorized(request)) return this.json(response, 401, { error: 'Unauthorized (token, Origin or Host rejected)' });
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (request.method === 'GET' && url.pathname === '/v1/status') return this.json(response, 200, this.status());
    if (request.method === 'GET' && url.pathname === '/v1/devices') return this.json(response, 200, [...this.devices.values()].map(d => d.info()));
    if (request.method === 'GET' && url.pathname === '/v1/events') {
      const since = Number(url.searchParams.get('since') ?? request.headers['last-event-id'] ?? 0);
      if (!Number.isSafeInteger(since) || since < 0) fail('since must be a nonnegative integer');
      const device = url.searchParams.get('device');
      const type = url.searchParams.get('type');
      const matches = (event: BridgeEvent) => (!device || event.deviceId === device || event.device?.id === device) && (!type || event.type === type);
      if (url.searchParams.get('follow') !== '1') return this.json(response, 200, this.events.filter(event => event.sequence > since && matches(event)));
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      response.write(': connected\n\n');
      this.streams.add(response);
      const queue: string[] = [];
      let queuedBytes = 0, blocked = false;
      let drainTimer: NodeJS.Timeout | undefined;
      const pump = () => {
        if (blocked || response.destroyed) return;
        while (queue.length) {
          const frame = queue.shift()!;
          queuedBytes -= Buffer.byteLength(frame);
          if (!response.write(frame)) {
            blocked = true;
            drainTimer = setTimeout(() => response.destroy(), 30000);
            drainTimer.unref();
            return;
          }
        }
      };
      const enqueue = (frame: string) => {
        if (response.destroyed) return;
        queuedBytes += Buffer.byteLength(frame);
        if (queuedBytes > 16 * 1024 * 1024) { response.destroy(); return; }
        queue.push(frame); pump();
      };
      const send = (event: BridgeEvent) => {
        if (matches(event)) enqueue(`id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`);
      };
      response.on('drain', () => { clearTimeout(drainTimer); blocked = false; pump(); });
      this.on('event', send);
      const timer = setInterval(() => enqueue(': keepalive\n\n'), 15000);
      timer.unref();
      response.once('close', () => {
        clearInterval(timer); clearTimeout(drainTimer); queue.length = 0;
        this.off('event', send); this.streams.delete(response);
      });
      for (const event of this.events) if (event.sequence > since) send(event);
      return;
    }
    if (request.method === 'POST' && url.pathname === '/v1/action') {
      if (!(request.headers['content-type'] ?? '').startsWith('application/json')) fail('Content-Type must be application/json', 415);
      const result = await this.executeInput(await bodyJson(request));
      return this.json(response, 'ok' in result && result.ok === false ? 502 : 200, result);
    }
    // Explicit opt-in compatibility for the VS Code extension's HTTP helper; never on device port.
    if (this.options.legacyExec && request.method === 'GET' && url.pathname === '/exec') {
      const cmd = url.searchParams.get('cmd');
      const location = text(url.searchParams.get('path'), 'path');
      const folder = location.startsWith('file:') ? fileURLToPath(location) : location;
      const target = { device: url.searchParams.get('device') || undefined, all: url.searchParams.get('all') === '1' };
      let result: CommandResponse;
      if (cmd === 'save') result = await this.execute({ action: 'save_project', folder, ...target });
      else if (cmd === 'rerun') {
        const id = path.resolve(folder);
        const script = await fs.readFile(id, 'utf8');
        const sessions = this.select(target);
        const results = await Promise.all(sessions.map(session => session.enqueue(async () => {
          await session.sendJson(envelope('command', { command: 'stopAll' }));
          await delay(1000);
          const message = envelope('command', { command: 'run', id, name: id, script });
          await session.sendJson(message);
          return { deviceId: session.id, status: 'sent' as const, messageId: message.message_id };
        }).catch(error => ({ deviceId: session.id, status: 'error' as const, error: errorMessage(error) }))));
        result = { results, ok: results.every(r => r.status !== 'error') };
      } else fail('Supported legacy cmd values: save, rerun');
      return this.json(response, result.ok ? 200 : 502, result);
    }
    this.json(response, 404, { error: 'Not found' });
  }

  stop() {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    this.stopPromise = (async () => {
      this.adb.untrack();
      await this.startPromise?.catch(() => {});
      // Stop accepting new TCP requests before device/ADB teardown.
      const serversClosed = Promise.all([stopServer(this.apiServer), stopServer(this.deviceServer)]);
      for (const socket of this.outbound) if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
      await Promise.allSettled([...this.sessions].map(session => session.close()));
      // Force shutdown after sending the protocol close rather than waiting on hostile peers.
      for (const session of this.sessions) session.socket.terminate();
      await this.adb.close();
      this.publish('bridge_stopped');
      for (const response of this.streams) response.end();
      await serversClosed;
      if (this.wsServer) await new Promise<void>(resolve => this.wsServer!.close(() => resolve()));
      this.started = false;
      this.emit('stopped');
    })();
    return this.stopPromise;
  }
}
