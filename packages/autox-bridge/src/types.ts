import type { AddressInfo } from 'node:net';

/** Extension protocol fields are deliberately unknown until validated. */
export type JsonObject = Record<string, unknown>;
export interface ProtocolMessage extends JsonObject {
  type: string;
  message_id?: unknown;
  data?: unknown;
}
export interface Envelope<T = unknown> extends ProtocolMessage {
  message_id: string;
  data: T;
}
export interface DeviceSessionOptions {
  id?: string;
  transport?: string;
  address?: string;
  handshakeTimeout?: number;
  heartbeatInterval?: number;
  compatVersion?: string;
}
export interface DeviceInfo {
  id: string;
  name: string | null;
  transport: string;
  address: string | null;
  connectedAt?: string;
  metadata: JsonObject;
}
export type ProjectSnapshot = Map<string, string>;
export interface PackageProjectOptions {
  full?: boolean;
  maxBytes?: number;
  referenceFiles?: boolean;
}
export interface PackagedProject {
  folder: string;
  buffer: Buffer;
  md5: string;
  snapshot: ProjectSnapshot;
  files: string[];
  removed: string[];
}
export interface TargetSelection { device?: string; all?: boolean }
export type DeviceAction = TargetSelection & (
  | { action: 'run' | 'rerun' | 'save'; id: string; script: string; name?: string }
  | { action: 'stop'; id: string }
  | { action: 'stopAll' | 'disconnect' }
  | { action: 'run_project' | 'save_project'; folder: string; full?: boolean; referenceFiles?: boolean }
  | { action: 'raw'; message: ProtocolMessage }
  | { action: 'bytes'; command: string; base64: string; data?: JsonObject }
);
export type BridgeAction = DeviceAction
  | { action: 'connect'; url: string }
  | { action: 'adb-connect'; serial: string }
  | { action: 'adb-list' | 'adb-track' | 'adb-untrack' | 'shutdown' };
export type CommandResult =
  | { deviceId: string; status: 'close_sent' }
  | { deviceId: string; status: 'error'; error: string }
  | { deviceId: string; status: 'sent'; messageId: unknown; files?: string[]; removed?: string[]; bytes?: number; md5?: string; warning?: string };
export interface CommandResponse { results: CommandResult[]; ok: boolean }
export interface AdbDevice { id: string; state: string; properties: Record<string, string> }
export interface TrackingStatus { tracking: boolean }
export interface ShutdownResponse { stopping: true }
export type ActionResponse = DeviceInfo | AdbDevice[] | TrackingStatus | ShutdownResponse | CommandResponse;
export type ActionResponseMap = { [A in DeviceAction['action']]: CommandResponse } & {
  connect: DeviceInfo; 'adb-connect': DeviceInfo; 'adb-list': AdbDevice[];
  'adb-track': TrackingStatus; 'adb-untrack': TrackingStatus; shutdown: ShutdownResponse;
};
export type ActionResponseFor<T extends BridgeAction> = ActionResponseMap[T['action']];
export interface BridgeStatus {
  started: boolean;
  pid: number;
  deviceAddress?: AddressInfo;
  apiAddress?: AddressInfo;
  devices: number;
  adbTracking: boolean;
  deviceUrls: string[];
}
export interface BridgeEventData extends JsonObject {
  deviceId?: string;
  device?: DeviceInfo;
  data?: unknown;
  message?: ProtocolMessage | string;
}
export interface PublishEventData extends BridgeEventData {
  sequence?: never;
  timestamp?: never;
  type?: never;
}
export interface BridgeEvent extends BridgeEventData {
  sequence: number;
  timestamp: string;
  type: string;
}
export interface EventFilters {
  since?: number;
  device?: string;
  type?: string;
  signal?: AbortSignal;
}
export interface BridgeClientOptions { url?: string; token?: string; timeout?: number }
