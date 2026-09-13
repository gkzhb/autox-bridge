# autox-bridge CLI 命令参考

对应 CLI 0.1.0。发生版本差异时先查看本机 `autox-bridge --version` 和具体子命令 `--help`，以真实实现为准，不猜测不存在的选项。所有示例只说明用法，不构成执行授权。

## 安装和调用

运行时 Node.js >=20；从源码安装使用 pnpm 11.5.3，工具本身要求 Node.js >=22.13。

在用户提供的 **autox-bridge 源码根目录**（包含 package.json）执行：

```sh
pnpm install --frozen-lockfile
pnpm pack
pnpm add -g ./autox-bridge-0.1.0.tgz
autox-bridge --version
autox --version
```

`pnpm pack` 会执行语法检查和测试。源码版本不为 0.1.0 时使用实际产物名。不要假定包已发布到 registry。若 `pnpm bin -g` 的路径不在 PATH，参考 pnpm 提示配置；修改全局配置或 shell 启动文件前确认影响。

不全局安装也能在源码根目录运行 `node bin/autox-bridge.js <参数>`；启动可用 `pnpm start --host 0.0.0.0`。安装后的 `autox` 与 `autox-bridge` 完全等价。

## 全局选项

| 选项 / 环境变量 | 行为 |
|---|---|
| `--url <url>` / `AUTOX_BRIDGE_URL` | 管理 API 地址，默认 http://127.0.0.1:9318；不是设备 WS 地址 |
| `--token <token>` / `AUTOX_BRIDGE_TOKEN` | 管理 API bearer token；优先安全注入环境变量，避免命令参数泄露 |
| `--timeout <ms>` | 普通 API 请求超时，默认 30000；日志流仅限制建立连接，不限制流持续时间 |
| `--json` | 一次性结果为 JSON；follow 结果为 NDJSON；错误在 stderr，非零退出 |
| `--version` / `--help` | 版本/帮助，不需要运行 bridge |

推荐把全局选项放在子命令之前。不要在命令、报告或文件里放真实 token。

## 连接与生命周期

| 命令 | 用途 / 注意 |
|---|---|
| `serve`（别名 `start`） | 常驻前台 bridge；Ctrl-C / SIGTERM 优雅关闭 |
| `status` | 当前监听地址、候选设备 URL、设备数量、ADB tracking 状态 |
| `devices`（别名 `list`） | 已完成握手的设备列表 |
| `connect <ws-url>` | 主动连接 Android 服务端，例如 ws://设备IP:9317/ |
| `disconnect --device <id>` | 协议断连，不保证停止脚本；tracking 可能重连 |
| `shutdown` | 关闭整个 bridge、会话及 tracking，影响全部使用者 |
| `adb list` | bridge 主机执行 adb，列出在线/离线/未授权设备 |
| `adb connect <serial>` | 转发本机动态端口到设备 9317，完成 WS 握手 |
| `adb track` / `adb untrack` | 开/关约 3 秒间隔自动发现重试；untrack 保留会话 |

`serve` 参数：

| 参数 | 默认 / 说明 |
|---|---|
| `--host <address>` | 设备 WS 绑定 127.0.0.1；LAN 使用 0.0.0.0 前确认网络边界 |
| `--port <port>` | 设备 WS 9317 |
| `--api-host <address>` | 管理 API 127.0.0.1；非回环必须 token |
| `--api-port <port>` | 管理 API 9318；修改后 CLI 使用相应 --url |
| `--adb` | 启动后开启 ADB tracking |
| `--adb-path <file>` | bridge 主机 adb 可执行文件，默认 adb |
| `--compat-version <version>` | hello 报告的插件兼容版本，默认 1.110.0，不是 npm 版本 |
| `--legacy-exec` | 显式开启旧 HTTP /exec 钩子；不是通常 CLI 工作流所需 |

修改端口示例（仅在已确认需要独立 bridge 时）：

```sh
autox-bridge serve --port 9417 --api-port 9418
autox-bridge --url http://127.0.0.1:9418 --json devices
```

这不改变 Android ADB 服务端固定目标端口 9317。上述回环设备绑定仅供本机/USB使用；LAN 手机不能直接访问。

## 目标选择与脚本

设备操作支持 `--device <id或唯一名称>` / `-d`，或 `--all` / `-a`；不能同时使用。省略时必须刚好一个设备。代理应优先显式 ID，而不是依赖数量或名称。

| 命令 | 参数与含义 |
|---|---|
| `run <file>` | 运行文件；`--id` 自定义身份，`--name` 自定义远端名字 |
| `rerun <file>` | 重跑指定脚本；参数同 run |
| `save <file>` | 保存但不运行；参数同 run |
| `run -` / `rerun -` / `save -` | 从 stdin 读取，必须显式 --id |
| `eval <script>` | 运行内联 AutoX JavaScript；默认 id 为 autox-cli-eval.js，可用 --id 修改 |
| `stop <script-id>` | 默认按本地文件路径解析；自定义 id 加 --exact |
| `stop-all` | 停止所选设备全部引擎；操作范围较大，不能作为重试兜底 |

`stop ./hello.js` 必须与 run 的文件绝对路径一致。不能用 `stop <messageId>` 停止脚本：报文 messageId 与脚本 id 不是一个概念。

## 项目

| 命令 | 参数与含义 |
|---|---|
| `new-project <folder>` | 本地创建 project.json/main.js；支持 --name，不覆盖已有文件，不接受设备参数 |
| `save-project <folder>` | ZIP + bytes_command 保存项目 |
| `run-project <folder>` | ZIP + bytes_command 保存并请求运行项目 |
| 项目 `--full` | 重发所有允许文件，不删除远端旧文件 |
| 项目 `--reference-files` | 使用插件 ignore 前缀语义，取消默认 .git/node_modules 排除；先审查敏感文件 |

project.json 示例：

```json
{
  "name": "Demo",
  "main": "main.js",
  "ignore": ["build", "private-data", "local-config.json"],
  "packageName": "com.example",
  "versionName": "1.0.0",
  "versionCode": 1
}
```

ignore 是路径，不是 glob；默认安全模式按路径组件匹配，`build` 不排除 `build-extra.js`。`--reference-files` 中 `build` 是字符串前缀，`build/` 则保留目录分隔语义。单项目未压缩内容上限略小于 64 MiB，单帧上限 64 MiB；不要规避限制盲传大目录。

## 日志和输出

`logs` / `events` 接受 `--follow`、`--device <精确ID>`、`--since <非负序号>`。不接受 `--all`；默认事件范围已涵盖所有设备。events 包含原始文本报文、日志和生命周期事件；二进制消息只记录大小。

一次性发送结果示意：

```json
{"ok":true,"results":[{"deviceId":"adb:SERIAL","status":"sent","messageId":"opaque-message-id"}]}
```

项目结果还包含 `files`、`removed`、`bytes`、`md5`，存在本地删除时有 warning。`ok:false` 时逐个看 results，部分目标可能已收到命令。CLI 错误输出至 stderr 并非零退出；不要仅凭 stdout 是否有 JSON 判断成功。

历史只在当前进程内保存，默认最多 1000 条且约 8 MiB；不能当作审计持久存储。follow 在连接结束/失败时退出，不会静默自动续连；重新订阅时检查进程是否重启，避免误用旧 since。

## 原始协议：仅用于明确已知的扩展需求

优先使用结构化子命令。只有用户需要诊断或已知版本扩展且理解影响时使用：

```sh
autox-bridge --json raw '{"type":"command","data":{"command":"stopAll"}}' --device "$DEVICE_ID"
autox-bridge --json bytes save_project ./project.zip --data '{"id":"demo","name":"demo"}' --device "$DEVICE_ID"
```

第一个示例会停止全部脚本，绝不是无副作用的连通性测试。`raw` 缺省生成 message_id；`bytes` 自动计算文件 MD5，先发二进制再发 bytes_command。未知命令是否被设备支持不得臆测，通过 events 观察。

旧 `/exec?cmd=rerun` 钩子与普通 `rerun` 不同：会 stopAll、等待 1 秒后 run。一般代理任务不需启用 `--legacy-exec`。协议没有直接 screenshot、tap、UI-tree、pull-file、list-engines 子命令；Android 动作须使用用户授权的 AutoX 脚本，不要编造 CLI 参数或结果。
