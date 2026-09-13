import { BridgeError } from './errors.js';
import { isRecord } from './protocol.js';
import type { ActionResponseFor, BridgeAction, BridgeClientOptions, BridgeEvent, BridgeStatus, DeviceInfo, EventFilters } from './types.js';

export class BridgeClient {
  url: URL;
  token: string;
  timeout: number;

  constructor({ url = 'http://127.0.0.1:9318', token = '', timeout = 30000 }: BridgeClientOptions = {}) {
    this.url = new URL(url);
    if (!['http:', 'https:'].includes(this.url.protocol) || this.url.username || this.url.password) throw new Error('API URL must be http(s) without credentials');
    this.token = token;
    this.timeout = timeout;
  }
  headers(): Record<string, string> { return this.token ? { authorization: `Bearer ${this.token}` } : {}; }
  request(route: '/v1/status'): Promise<BridgeStatus>;
  request(route: '/v1/devices'): Promise<DeviceInfo[]>;
  request<T = unknown>(route: string, body?: unknown): Promise<T>;
  async request<T = unknown>(route: string, body?: unknown): Promise<T> {
    const response = await fetch(new URL(route, this.url), {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...this.headers(), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(this.timeout), redirect: 'error',
    });
    const data: unknown = await response.json();
    if (!response.ok) {
      throw new BridgeError(isRecord(data) && typeof data.error === 'string' ? data.error : `Bridge request failed (${response.status})`, response.status, data);
    }
    return data as T;
  }
  action<T extends BridgeAction>(input: T): Promise<ActionResponseFor<T>> { return this.request('/v1/action', input); }

  async *events({ since = 0, device, type, signal }: EventFilters = {}): AsyncGenerator<BridgeEvent, void, unknown> {
    const url = new URL('/v1/events', this.url);
    url.search = new URLSearchParams({ follow: '1', since: String(since), ...(device ? { device } : {}), ...(type ? { type } : {}) }).toString();
    // Timeout only connection establishment. The stream stays open until explicitly cancelled.
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error('Event connection timed out')), this.timeout);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await fetch(url, { headers: this.headers(), signal: controller.signal, redirect: 'error' });
      clearTimeout(timer);
      if (!response.ok) throw new Error(`Event stream rejected (${response.status}): ${await response.text()}`);
      if (!response.body) throw new Error('Event stream has no response body');
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true });
        let boundary;
        while ((boundary = pending.indexOf('\n\n')) !== -1) {
          const frame = pending.slice(0, boundary);
          pending = pending.slice(boundary + 2);
          const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
          if (data) yield JSON.parse(data);
        }
      }
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      await reader?.cancel().catch(() => {});
      controller.abort();
    }
  }
}
