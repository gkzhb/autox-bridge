import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import type { RawData } from 'ws';
import type { DeviceInfo, DeviceSessionOptions, Envelope, JsonObject, ProjectSnapshot, ProtocolMessage } from './types.js';

export const COMPAT_VERSION = '1.110.0';
export const MAX_PAYLOAD = 64 * 1024 * 1024;
export const isRecord = (value: unknown): value is JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value);
export const envelope = <T>(type: string, data: T): Envelope<T> => ({ type, message_id: randomUUID(), data });

export type DeviceSessionEvents = {
  attach: [DeviceSession]; disconnect: [{ code: number; reason: string }];
  warning: [unknown]; binary: [RawData]; message: [ProtocolMessage];
  update: [DeviceInfo]; log: [unknown];
};

export type { DeviceInfo, DeviceSessionOptions, Envelope, ProtocolMessage } from './types.js';

/** A device sends hello first, whether its socket is inbound (LAN) or outbound (ADB). */
export class DeviceSession extends EventEmitter<DeviceSessionEvents> {
  socket: WebSocket;
  id: string;
  transport: string;
  address?: string;
  compatVersion: string;
  attached: boolean;
  closed: boolean;
  metadata: JsonObject;
  projects: Map<string, ProjectSnapshot>;
  queue: Promise<unknown>;
  ready: Promise<DeviceSession>;
  private resolveReady!: (session: DeviceSession) => void;
  private rejectReady!: (error: Error) => void;
  handshakeTimer: NodeJS.Timeout;
  heartbeat?: NodeJS.Timeout;
  closeTimer?: NodeJS.Timeout;
  closePromise?: Promise<void>;
  alive: boolean;
  name?: string;
  connectedAt?: string;

  constructor(socket: WebSocket, { id = randomUUID(), transport = 'tcp', address, handshakeTimeout = 10000,
    heartbeatInterval = 10000, compatVersion = COMPAT_VERSION }: DeviceSessionOptions = {}) {
    super();
    this.socket = socket; this.id = id; this.transport = transport;
    this.address = address; this.compatVersion = compatVersion;
    this.attached = false;
    this.closed = false;
    this.metadata = {};
    this.projects = new Map();
    this.queue = Promise.resolve();
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    // Inbound sessions may have no caller awaiting readiness.
    this.ready.catch(() => {});
    socket.on('message', (bytes, binary) => this.receive(bytes, binary));
    socket.on('error', error => this.emit('warning', error));
    socket.once('close', (code, reason) => this.finish(code, reason.toString()));
    this.handshakeTimer = setTimeout(() => {
      this.emit('warning', new Error('AutoX hello handshake timed out'));
      socket.terminate();
    }, handshakeTimeout);
    this.handshakeTimer.unref();
    this.alive = true;
    socket.on('pong', () => { this.alive = true; });
    if (heartbeatInterval > 0) {
      this.heartbeat = setInterval(() => {
        if (!this.alive) return socket.terminate();
        this.alive = false;
        if (socket.readyState === WebSocket.OPEN) socket.ping();
      }, heartbeatInterval);
      this.heartbeat.unref();
    }
  }

  info(): DeviceInfo {
    return { id: this.id, name: this.name ?? null, transport: this.transport,
      address: this.address ?? null, connectedAt: this.connectedAt, metadata: this.metadata };
  }

  receive(bytes: RawData, binary: boolean) {
    if (binary) { this.emit('binary', bytes); return; }
    let message: unknown;
    try {
      message = JSON.parse(bytes.toString());
      if (!isRecord(message) || typeof message.type !== 'string') throw new Error('Invalid AutoX message envelope');
      if (message.type === 'hello' && !isRecord(message.data)) throw new Error('hello.data must be an object');
    } catch (error) { this.emit('warning', error); return; }
    this.emit('message', message as ProtocolMessage);
    const { type, data } = message;
    if (type === 'hello' && isRecord(data)) {
      const reply: Envelope<string> & { debug: boolean; version?: string } = { ...envelope('hello', Number(data.app_version_code) >= 629 ? 'ok' : '连接成功'), debug: false };
      if (Number(data.app_version_code) >= 629) reply.version = this.compatVersion;
      // Queue the ACK before publishing the session so subsequent commands follow it.
      this.sendJson(reply).then(() => {
        if (this.closed) return;
        this.metadata = data;
        this.name = typeof data.device_name === 'string' ? data.device_name : this.id;
        if (!this.attached) {
          clearTimeout(this.handshakeTimer);
          this.attached = true;
          this.connectedAt = new Date().toISOString();
          this.emit('attach', this);
          this.resolveReady(this);
        }
      }).catch(error => { this.emit('warning', error); this.socket.terminate(); });
    } else if (type === 'ping') {
      this.sendJson({ type: 'pong', data }).catch(error => this.emit('warning', error));
    } else if (type === 'close') {
      this.socket.close();
    } else if (this.attached && type === 'device_name') {
      const name = typeof data === 'string' ? data : (isRecord(data) ? data.device_name : undefined);
      if (typeof name === 'string') { this.name = name; this.emit('update', this.info()); }
    } else if (this.attached && type === 'log') {
      this.emit('log', data);
    }
  }

  finish(code: number, reason: string) {
    if (this.closed) return;
    this.closed = true;
    this.attached = false;
    clearTimeout(this.handshakeTimer);
    clearTimeout(this.closeTimer);
    clearInterval(this.heartbeat);
    this.projects.clear();
    this.rejectReady(new Error(`Device disconnected before handshake (${code}: ${reason})`));
    this.emit('disconnect', { code, reason });
  }

  send(payload: string | Buffer, binary = false): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (this.closed || this.socket.readyState !== WebSocket.OPEN) return reject(new Error(`Device ${this.id} is disconnected`));
      if (Buffer.byteLength(payload) > MAX_PAYLOAD) return reject(new Error('Outgoing frame exceeds 64 MiB limit'));
      if (this.socket.bufferedAmount > MAX_PAYLOAD) return reject(new Error('Device send buffer is full'));
      this.socket.send(payload, { binary }, error => error ? reject(error) : resolve());
    });
  }

  sendJson(message: ProtocolMessage) { return this.send(JSON.stringify(message)); }

  /** Serialize entire operations, including project snapshot preparation and its two frames. */
  enqueue<T>(operation: () => T | PromiseLike<T>): Promise<T> {
    const next = this.queue.then(() => {
      if (!this.attached) throw new Error(`Device ${this.id} is not attached`);
      return operation();
    });
    this.queue = next.catch(() => {});
    return next;
  }

  close() {
    if (this.closePromise) return this.closePromise;
    if (this.closed) return Promise.resolve();
    this.closePromise = new Promise<void>(resolve => {
      const done = () => { clearTimeout(this.closeTimer); resolve(); };
      this.socket.once('close', done);
      // Arm before send: a non-reading peer must not block shutdown indefinitely.
      this.closeTimer = setTimeout(() => {
        this.socket.terminate();
        this.socket.off('close', done);
        resolve();
      }, 500);
      this.closeTimer.unref();
      this.sendJson({ ...envelope('close', 'close'), debug: false })
        .catch(() => {})
        .finally(() => { if (!this.closed) this.socket.close(); });
    });
    return this.closePromise;
  }
}
