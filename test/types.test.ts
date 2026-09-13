import { AutoXBridge, BridgeClient, AdbManager, BridgeError, packageProject } from 'autox-bridge';
import type { BridgeAction, BridgeEvent, CommandResponse, DeviceInfo, BridgeStatus, ShutdownResponse } from 'autox-bridge';
import { envelope, DeviceSession } from 'autox-bridge/protocol';
import type { DeviceSessionOptions } from 'autox-bridge/protocol';

const bridge = new AutoXBridge({ port: 0, apiPort: 0, heartbeatInterval: 0 });
const client = new BridgeClient({ timeout: 1000 });
const command: Promise<CommandResponse> = bridge.execute({ action: 'run', id: 'demo', script: '' });
const connected: Promise<DeviceInfo> = client.action({ action: 'connect', url: 'ws://localhost:9317' });
const status: Promise<BridgeStatus> = client.request('/v1/status');
const shutdown: Promise<ShutdownResponse> = client.action({ action: 'shutdown' });
const custom: Promise<{ value: number }> = client.request<{ value: number }>('/custom');
const options: DeviceSessionOptions = { id: 'non-uuid-id', heartbeatInterval: 0 };
const message = envelope('command', { command: 'stopAll' });
const messageId: string = message.message_id;
const action: BridgeAction = { action: 'save_project', folder: '/tmp/demo', full: true };
bridge.on('event', event => { const typed: BridgeEvent = event; void typed; });
bridge.once('stopped', () => {});
const adb = new AdbManager(bridge, { exec: async (_file, args, options) => {
  const timeout: number = options.timeout;
  const arg: string | undefined = args[0];
  void timeout; void arg;
  return { stdout: '' };
} });
const transfer = packageProject('/tmp/demo', new Map<string, string>(), { referenceFiles: true });
const error: unknown = new BridgeError('oops', 400, { detail: 'invalid' });
if (error instanceof BridgeError) { const status: number = error.status; void status; }

// @ts-expect-error script content is mandatory
client.action({ action: 'run', id: 'demo' });
// @ts-expect-error execute is typed even though HTTP input is validated at runtime
bridge.execute({ action: 'run', id: 'demo' });
// @ts-expect-error unsupported action
client.action({ action: 'invented' });
// @ts-expect-error runtime port must be numeric
new AutoXBridge({ port: '9317' });
// @ts-expect-error raw envelopes require a type
client.action({ action: 'raw', message: { data: [] } });
// @ts-expect-error typed event callback
bridge.on('event', (event: number) => {});

void [command, connected, status, shutdown, custom, options, messageId, action, adb, transfer, DeviceSession];

// Union-valued actions must preserve every possible response type.
function control(input: { action: 'adb-list' | 'shutdown' }) {
  const result: Promise<import('autox-bridge').AdbDevice[] | ShutdownResponse> = client.action(input);
  return result;
}
void control;

bridge.publish('warning', { message: 'boom' });
// @ts-expect-error generated event sequence is reserved
bridge.publish('custom', { sequence: 'not-a-number' });
// @ts-expect-error devices must have DeviceInfo shape
bridge.publish('custom', { device: 123 });
bridge.on('event', event => {
  if (typeof event.message === 'string') event.message.toUpperCase();
  else if (event.message) event.message.type.toUpperCase();
});
function allActions(input: BridgeAction) {
  const result: Promise<import('autox-bridge').ActionResponse> = client.action(input);
  return result;
}
void allActions;
