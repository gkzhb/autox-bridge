import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);

/** Uses Android platform-tools, never invokes a shell. */
export class AdbManager {
  constructor(bridge, { executable = 'adb', interval = 3000, exec = execFileAsync } = {}) {
    Object.assign(this, { bridge, executable, interval, exec });
    this.forwards = new Map();
    this.pending = new Map();
    this.removals = new Map();
    this.generation = 0;
    this.scans = new Set();
    this.startups = new Set();
    this.tracking = false;
    this.stopped = false;
  }
  async run(args) {
    const { stdout } = await this.exec(this.executable, args, { timeout: 10000, maxBuffer: 1024 * 1024 });
    return stdout.trim();
  }
  async list() {
    const text = await this.run(['devices', '-l']);
    return text.split(/\r?\n/).filter(line => line && !line.startsWith('List of') && !line.startsWith('*')).map(line => {
      const [id, state, ...properties] = line.trim().split(/\s+/);
      return { id, state, properties: Object.fromEntries(properties.filter(s => s.includes(':')).map(s => {
        const i = s.indexOf(':'); return [s.slice(0, i), s.slice(i + 1)];
      })) };
    });
  }
  connect(id) {
    if (typeof id !== 'string' || !id || id.startsWith('-')) return Promise.reject(new Error('A valid ADB serial is required'));
    if (this.stopped) return Promise.reject(new Error('ADB manager is shutting down'));
    const existing = this.bridge.devices.get(`adb:${id}`);
    if (existing) return Promise.resolve(existing.info());
    if (this.pending.has(id)) return this.pending.get(id);
    const operation = this.connectOnce(id).finally(() => this.pending.delete(id));
    this.pending.set(id, operation);
    return operation;
  }
  async connectOnce(id) {
    // Own every mapping we create; do not reuse/remove another application's forward.
    if (this.forwards.has(id)) {
      await this.removeForward(id);
      if (this.forwards.has(id)) throw new Error(`Previous ADB forward cleanup still failing: ${id}`);
    }
    const output = await this.run(['-s', id, 'forward', 'tcp:0', 'tcp:9317']);
    const port = Number(output);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`ADB returned invalid forwarded port: ${output}`);
    this.forwards.set(id, port);
    try {
      if (this.stopped) throw new Error('ADB manager is shutting down');
      return await this.bridge.connect(`ws://127.0.0.1:${port}/`, { id: `adb:${id}`, transport: 'adb' });
    } catch (error) {
      await this.removeForward(id);
      throw error;
    }
  }
  removeForward(id) {
    if (this.removals.has(id)) return this.removals.get(id);
    const port = this.forwards.get(id);
    if (port === undefined) return Promise.resolve();
    const operation = (async () => {
      try {
        await this.run(['-s', id, 'forward', '--remove', `tcp:${port}`]);
        if (this.forwards.get(id) === port) this.forwards.delete(id);
      } catch (error) {
        this.bridge.publish('warning', { source: 'adb', message: `Forward cleanup failed (${id}, tcp:${port}): ${error.message}` });
      }
    })().finally(() => this.removals.delete(id));
    this.removals.set(id, operation);
    return operation;
  }
  async scan(generation = this.generation) {
    const list = await this.list();
    const current = () => this.tracking && this.generation === generation && !this.stopped;
    if (!current()) return list;
    const online = new Set(list.filter(device => device.state === 'device').map(device => device.id));
    for (const [key, device] of this.bridge.devices) {
      if (!current()) return list;
      if (device.transport === 'adb' && !online.has(key.slice(4))) await device.close();
    }
    await Promise.all([...online].map(async id => {
      if (!current()) return;
      try { await this.connect(id); }
      catch (error) { this.bridge.publish('warning', { source: 'adb', id, message: error.message }); }
    }));
    return list;
  }
  track() {
    if (this.stopped) return Promise.reject(new Error('ADB manager is shutting down'));
    if (this.trackPromise) return this.trackPromise;
    if (this.tracking) return Promise.resolve({ tracking: true });
    const generation = ++this.generation;
    const operation = (async () => {
      await this.list();
      if (generation !== this.generation || this.stopped) return { tracking: false };
      this.tracking = true;
      const tick = () => {
        if (!this.tracking || generation !== this.generation || this.stopped) return;
        this.scanTask = this.scan(generation).catch(error => {
          this.bridge.publish('warning', { source: 'adb', message: error.message });
        }).finally(() => {
          if (this.tracking && generation === this.generation && !this.stopped) {
            this.timer = setTimeout(tick, this.interval); this.timer.unref();
          }
        });
        const task = this.scanTask;
        this.scans.add(task);
        task.finally(() => this.scans.delete(task)).catch(() => {});
      };
      tick();
      return { tracking: true };
    })();
    this.trackPromise = operation;
    this.startups.add(operation);
    operation.finally(() => this.startups.delete(operation)).catch(() => {});
    operation.finally(() => { if (this.trackPromise === operation) this.trackPromise = undefined; }).catch(() => {});
    return operation;
  }
  untrack() {
    ++this.generation;
    this.tracking = false;
    this.trackPromise = undefined;
    clearTimeout(this.timer);
    return { tracking: false };
  }
  async close() {
    this.stopped = true;
    const starting = this.trackPromise;
    this.untrack();
    await starting?.catch(() => {});
    await Promise.allSettled([...this.startups]);
    await Promise.allSettled([...this.scans]);
    await Promise.allSettled([...this.pending.values()]);
    await Promise.all([...this.removals.values()]);
    // Bounded retry: preserve ownership on failure, never remove another tool's mapping.
    for (let attempt = 0; attempt < 2 && this.forwards.size; attempt++) {
      await Promise.all([...this.forwards.keys()].map(id => this.removeForward(id)));
    }
  }
}
