# AutoX protocol and management API

Compatibility reference: Auto.js-VSCode-Extension **1.110.0** `src/autojs-debug.ts`, `src/extension.ts`, `src/project.ts`, `src/diff.ts`. No independently complete upstream specification was present (`protocol.md` only sketches hello).

## Transport

Device-facing WebSocket at any path, default TCP 9317. Text frames are UTF-8 JSON; binary frames are raw ZIP/file bytes. No additional TCP framing or base64 wrapper on the device wire. Nonempty browser Origin headers are rejected; loopback bindings also validate Host. Native clients without Origin are accepted. Host may accept inbound LAN connections or dial an Android server directly/through `adb forward tcp:0 tcp:9317`.

Regardless of connection direction, Android initiates hello within 10 seconds:

```json
{"type":"hello","data":{"device_name":"Pixel","app_version_code":629}}
```

For app_version_code >= 629 the host responds:

```json
{"type":"hello","message_id":"<unique-string>","data":"ok","version":"1.110.0","debug":false}
```

Older/missing app version receives `data:"连接成功"` and no `version`. Reported compatibility version is independent of npm version and configurable with `serve --compat-version`. Repeated hello is acknowledged without duplicating device registration.

Application heartbeat `{type:"ping",data:X}` receives `{type:"pong",data:X}` exactly; additional WebSocket ping frames are sent every 10s, with a peer terminated on the next tick if no WS pong arrives.

## Command matrix

All ordinary host commands use:

```json
{"type":"command","message_id":"<unique-string>","data":{"command":"run","id":"/abs/hello.js","name":"/abs/hello.js","script":"toast('hello')"}}
```

| Command | Fields in data besides command | CLI |
|---|---|---|
| run | id, name, script | run, eval |
| rerun | id, name, script | rerun |
| save | id, name, script | save |
| stop | id | stop |
| stopAll | none | stop-all |

For projects: binary ZIP frame first, then text frame:

```json
{"type":"bytes_command","message_id":"<unique-string>","md5":"<lowercase MD5 of exact ZIP bytes>","data":{"command":"save_project","id":"/abs/project","name":"/abs/project"}}
```

`run_project` has the same structure. ZIP entries use relative forward-slash paths, no outer project directory. Initial transfer includes all allowed files; later transfers include only changed/new files for that session and folder. No tombstones/deletion messages. An empty delta is still a valid empty ZIP. Sends are serialized per device; a binary frame and its corresponding command cannot interleave with another queued command/transfer (heartbeat control replies may occur independently).

Device logs: `{"type":"log","data":{"log":"text"}}`. All inbound text messages are also emitted as raw `message` events; unknown types are not discarded. `device_name` can update display name. Unsolicited binary frames are surfaced as size-only events, not downloadable artifacts.

Host close: `{"type":"close","message_id":"<unique-string>","data":"close","debug":false}` followed by WebSocket close. Handshake timeout, transport closure/error and heartbeat failures detach sessions.

**No command completion/result ACK is specified by the reference.** `message_id` is an opaque correlation identifier; this implementation uses UUIDs instead of the plugin's timestamp/random string. `sent` reports local WS send completion only.

## Local management API (not Android protocol)

Default `http://127.0.0.1:9318`. If a token is configured, every route needs `Authorization: Bearer TOKEN`. Requests with Origin are rejected; non-loopback binding requires token. JSON responses, no CORS. API owners are trusted administrators of the bridge host.

| Method | Route | Result |
|---|---|---|
| GET | /v1/status | Ports, URLs, device count, tracking state |
| GET | /v1/devices | Attached device info array |
| POST | /v1/action | Execute JSON action below |
| GET | /v1/events | Bounded event history array |
| GET | /v1/events?follow=1 | SSE stream with history replay |
| GET | /exec | Optional legacy helper, disabled by default |

Events filters: `since=<sequence>`, `device=<exact-id>`, `type=log|message|...`. SSE supports Last-Event-ID when since is absent. Frames have `id: SEQUENCE` and `data: JSON`, with heartbeat comments every 15s. Writes respect stream backpressure; per-subscriber queues are bounded to 16 MiB and stalled drains to 30 seconds, after which slow consumers are disconnected. Sequence restarts with bridge process; callers must reset their cursor after restart. Live log CLI stops on stream end/error rather than silently reconnecting and losing events.

POST requires `Content-Type: application/json`. Examples:

```json
{"action":"run","id":"demo","name":"demo.js","script":"console.log(device.model)","device":"adb:SERIAL"}
{"action":"stop","id":"demo","all":true}
{"action":"stopAll","all":true}
{"action":"save_project","folder":"/absolute/path/on/bridge/host","full":false}
{"action":"connect","url":"ws://192.168.1.30:9317"}
{"action":"disconnect","device":"adb:SERIAL"}
{"action":"adb-list"}
{"action":"adb-connect","serial":"SERIAL"}
{"action":"adb-track"}
{"action":"adb-untrack"}
{"action":"shutdown"}
{"action":"raw","message":{"type":"custom","data":{}}}
{"action":"bytes","command":"save_project","base64":"UEsFBgAAAAAAAAAAAAAAAAAAAAAAAA==","data":{"id":"demo","name":"demo"}}
```

`run`, `rerun`, `save` require string script and nonempty id; name defaults to id. `run_project` and `save_project` require folder with project.json. Set `referenceFiles:true` to use reference ignore prefixes and disable default .git/node_modules exclusions. `device` resolves exact ID first, otherwise unique name; `all:true` broadcasts and cannot coexist with device. Omitted selection requires exactly one attached device.

Successful sends:

```json
{"ok":true,"results":[{"deviceId":"...","status":"sent","messageId":"..."}]}
```

Project results additionally contain `files`, `removed`, `bytes`, `md5`, and a deletion warning if needed. Target failures return HTTP 502 with `ok:false` and individual `status:"error"` results; already successful targets are not rolled back. Transport send success is not execution success. Validation/not-found/conflict errors generally use HTTP 400/404/409; malformed JSON is 400, unsupported media 415, excessive body 413. IO/ADB failures return 500 with error details. CLI errors use a nonzero exit code and stderr; successful `--json` emits JSON on stdout, streaming emits NDJSON.

## Deliberate differences from the plugin

- Separate, loopback-first management port instead of exposing filesystem-triggering /exec on device LAN port.
- Explicit multi-device selection rather than unconditional broadcast.
- UUID inbound session IDs; ADB IDs prefixed with `adb:`.
- Safe file boundaries and content-hash diffs, not mtime-only/prefix false positives.
- Default excludes .git/node_modules and refuses symlinks. `--reference-files` restores reference include/prefix selection, but symlink/path safety checks remain.
- Cleanup of only self-owned ADB forwards; tracking implemented with periodic authorized-device scans/retries rather than adbkit events.
- No VS Code editor, shortcut, webview/QR image or documentation panel dependency; connection URLs are returned directly.
- No claims about commands absent from reference code, including file deletion, screen capture transport, UI tree retrieval, remote engine enumeration or ACK semantics.
