import type { BridgeAction, BridgeClientOptions, BridgeEvent, JsonObject, TargetSelection } from './types.js';
import { BridgeError, errorMessage } from './errors.js';
import { isRecord } from './protocol.js';

import { Command, InvalidArgumentError, Option } from 'commander';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { BridgeOptions } from './bridge.js';
import { AutoXBridge } from './bridge.js';
import { BridgeClient } from './client.js';
import { createProject } from './project.js';
import { registerScriptCommands } from './scripts/cli.js';

interface GlobalOptions extends BridgeClientOptions { json?: boolean }
interface ServeOptions extends Omit<BridgeOptions, 'adb'> { adb?: boolean; adbPath: string }
interface ScriptOptions extends TargetSelection { id?: string; name?: string }
interface EvalOptions extends TargetSelection { id: string }
interface StopOptions extends TargetSelection { exact?: boolean }
interface ProjectOptions extends TargetSelection { full?: boolean; referenceFiles?: boolean }
interface BytesOptions extends TargetSelection { data: JsonObject }
interface LogOptions { since: number; device?: string; follow?: boolean }

function integer(value: string) {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new InvalidArgumentError('Expected a nonnegative integer');
  return Number(value);
}
function jsonObject(value: string) {
  let data: unknown;
  try { data = JSON.parse(value); } catch { throw new InvalidArgumentError('Expected valid JSON'); }
  if (!isRecord(data)) throw new InvalidArgumentError('Expected a JSON object');
  return data;
}
function rawMessage(value: string) {
  const data = jsonObject(value);
  if (typeof data.type !== 'string') throw new InvalidArgumentError('message must be an object with a type');
  return { ...data, type: data.type };
}
async function stdin() { const chunks: Buffer[] = []; for await (const chunk of process.stdin) chunks.push(chunk); return Buffer.concat(chunks).toString(); }
function target(command: Command) { return command.option('-d, --device <id-or-name>', 'Target device ID or unique name').option('-a, --all', 'Explicitly target all attached devices'); }
const selection = (options: TargetSelection) => ({ device: options.device, all: options.all ?? false });

export function buildProgram() {
  const program = new Command();
  program.name('autox-bridge').description('AutoX.js persistent device bridge and CLI (alias: autox)').version('0.1.0')
    .option('--url <url>', 'Bridge management API URL', process.env.AUTOX_BRIDGE_URL ?? 'http://127.0.0.1:9318')
    .addOption(new Option('--token <token>', 'API bearer token (prefer AUTOX_BRIDGE_TOKEN)').default(process.env.AUTOX_BRIDGE_TOKEN ?? '', '[redacted]'))
    .option('--timeout <ms>', 'API request timeout', integer, 30000)
    .option('--json', 'Machine-readable JSON output (NDJSON for streams)');
  const client = () => new BridgeClient(program.opts<GlobalOptions>());
  const print = (value: unknown) => {
    if (program.opts<GlobalOptions>().json) console.log(JSON.stringify(value));
    else console.log(JSON.stringify(value, null, 2));
  };
  const action = async (input: BridgeAction) => print(await client().action(input));
  registerScriptCommands(program, print, action);

  program.command('serve').alias('start').description('Run the bridge in the foreground; stop with SIGINT/SIGTERM')
    .option('--host <address>', 'Device WebSocket bind address; use 0.0.0.0 for LAN', '127.0.0.1')
    .option('--port <port>', 'Device WebSocket port', integer, 9317)
    .option('--api-host <address>', 'Management bind address (non-loopback requires token)', '127.0.0.1')
    .option('--api-port <port>', 'Management port', integer, 9318)
    .option('--adb', 'Track and connect authorized ADB devices')
    .option('--adb-path <file>', 'Platform-tools adb executable', 'adb')
    .option('--legacy-exec', 'Enable authenticated legacy /exec hook on management port')
    .option('--compat-version <version>', 'Version reported to modern AutoX clients', '1.110.0')
    .action(async (options: ServeOptions) => {
      const bridge = new AutoXBridge({ ...options, token: program.opts<GlobalOptions>().token,
        adb: { executable: options.adbPath }, legacyExec: options.legacyExec ?? false });
      const stop = () => { void bridge.stop().catch(error => { console.error(error.message); process.exitCode = 1; }); };
      process.once('SIGINT', stop); process.once('SIGTERM', stop);
      const stopped = new Promise<void>(resolve => bridge.once('stopped', resolve));
      try {
        bridge.on('event', (event: BridgeEvent) => {
          if (event.type === 'warning') console.error(JSON.stringify(event));
          if (event.type === 'log' && !program.opts<GlobalOptions>().json) console.error(`[${event.deviceId}] ${(isRecord(event.data) ? event.data.log : undefined) ?? JSON.stringify(event.data)}`);
        });
        print(await bridge.start());
        if (options.host === '0.0.0.0' || options.host === '::') console.error('WARNING: AutoX device protocol is unauthenticated. Use a trusted LAN/VPN and firewall.');
        if (options.adb) await bridge.adb.track();
        await stopped;
      } finally {
        await bridge.stop();
        process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
      }
    });
  program.command('status').description('Bridge state and connection addresses').action(async () => print(await client().request('/v1/status')));
  program.command('devices').alias('list').description('List attached AutoX devices').action(async () => print(await client().request('/v1/devices')));
  program.command('shutdown').description('Stop bridge, ADB tracking and device sessions').action(() => action({ action: 'shutdown' }));
  program.command('connect <ws-url>').description('Connect to an AutoX device in server mode (ws://device:9317)').action((url: string) => action({ action: 'connect', url }));
  target(program.command('disconnect').description('Disconnect selected device(s); ADB tracking may reconnect')).action((options: TargetSelection) => action({ action: 'disconnect', ...selection(options) }));

  for (const name of ['run', 'rerun', 'save'] as const) {
    target(program.command(`${name} <file>`).description(`${name} script; use - to read stdin`))
      .option('--id <id>', 'Script identity (default absolute file path; required for stdin)')
      .option('--name <name>', 'Remote script name (default identity)')
      .action(async (file: string, options: ScriptOptions) => {
        if (file === '-' && !options.id) throw new Error('--id is required when reading stdin');
        const id = options.id ?? path.resolve(file);
        const script = file === '-' ? await stdin() : await fs.readFile(file, 'utf8');
        await action({ action: name, id, name: options.name ?? id, script, ...selection(options) });
      });
  }
  target(program.command('eval <script>').description('Run inline AutoX JavaScript'))
    .option('--id <id>', 'Script identity for later stop/rerun', 'autox-cli-eval.js')
    .action((script: string, options: EvalOptions) => action({ action: 'run', id: options.id, name: options.id, script, ...selection(options) }));
  target(program.command('stop <script-id>').description('Stop a script using its exact id (file paths resolve by default)'))
    .option('--exact', 'Use literal id without resolving as a path')
    .action((id: string, options: StopOptions) => action({ action: 'stop', id: options.exact ? id : path.resolve(id), ...selection(options) }));
  target(program.command('stop-all').description('Stop all script engines on selected devices'))
    .action((options: TargetSelection) => action({ action: 'stopAll', ...selection(options) }));
  for (const name of ['run', 'save'] as const) {
    target(program.command(`${name}-project <folder>`).description(`${name} project using binary ZIP + bytes_command`))
      .option('--full', 'Send all files, bypassing per-device incremental snapshot')
      .option('--reference-files', 'Use reference ignore prefixes without default .git/node_modules excludes')
      .action((folder: string, options: ProjectOptions) => action({ action: `${name}_project`, folder: path.resolve(folder), full: options.full ?? false, referenceFiles: options.referenceFiles ?? false, ...selection(options) }));
  }
  program.command('new-project <folder>').description('Create project.json and main.js without overwriting existing files')
    .option('--name <name>', 'Project display name').action(async (folder: string, options: { name?: string }) => print(await createProject(folder, options.name)));

  target(program.command('raw <message-json>').description('Send a raw AutoX JSON envelope; no invented ACK semantics'))
    .action((json: string, options: TargetSelection) => action({ action: 'raw', message: rawMessage(json), ...selection(options) }));
  target(program.command('bytes <command> <file>').description('Send binary file + bytes_command with computed MD5'))
    .option('--data <json>', 'Extra bytes_command data object', jsonObject, {})
    .action(async (command: string, file: string, options: BytesOptions) => action({ action: 'bytes', command, base64: (await fs.readFile(file)).toString('base64'), data: options.data, ...selection(options) }));

  for (const name of ['logs', 'events']) {
    program.command(name).description(name === 'logs' ? 'Device logs (snapshot or live stream)' : 'All protocol/lifecycle events (snapshot or live stream)')
      .option('-f, --follow', 'Stream events until interrupted')
      .option('-d, --device <id>', 'Filter by exact device ID')
      .option('--since <sequence>', 'Only events after this sequence', integer, 0)
      .action(async (options: LogOptions) => {
        const filters = { since: options.since, device: options.device, ...(name === 'logs' ? { type: 'log' } : {}) };
        if (!options.follow) {
          const query = new URLSearchParams(Object.entries(filters).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)]));
          print(await client().request(`/v1/events?${query}`));
          return;
        }
        const controller = new AbortController();
        const stop = () => controller.abort();
        process.once('SIGINT', stop); process.once('SIGTERM', stop);
        try {
          for await (const event of client().events({ ...filters, signal: controller.signal })) {
            if (!program.opts<GlobalOptions>().json && name === 'logs') console.log(`[${event.timestamp}] [${event.deviceId}] ${(isRecord(event.data) ? event.data.log : undefined) ?? JSON.stringify(event.data)}`);
            else console.log(JSON.stringify(event));
          }
        } catch (error) { if (!controller.signal.aborted) throw error; }
        finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
      });
  }
  const adb = program.command('adb').description('Manage USB/ADB device connections through the running bridge');
  adb.command('list').action(() => action({ action: 'adb-list' }));
  adb.command('connect <serial>').action((serial: string) => action({ action: 'adb-connect', serial }));
  adb.command('track').description('Start polling, auto-connect and retry every 3s').action(() => action({ action: 'adb-track' }));
  adb.command('untrack').description('Stop discovery/retry; keep current sessions').action(() => action({ action: 'adb-untrack' }));
  return program;
}

export async function main(argv = process.argv) {
  const program = buildProgram();
  try { await program.parseAsync(argv); }
  catch (error) {
    const message = errorMessage(error);
    const extra = error instanceof BridgeError ? error.details : undefined;
    const details = { error: message, ...(extra ? { details: extra } : {}) };
    console.error(program.opts<GlobalOptions>().json ? JSON.stringify(details) : `Error: ${message}${extra ? '\n' + JSON.stringify(extra, null, 2) : ''}`);
    process.exitCode = 1;
  }
}
