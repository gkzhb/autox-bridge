# autox-bridge

独立于 VS Code 的 **AutoX.js / Auto.js 设备桥接 npm 包**，提供 `autox-bridge` CLI（以及等价别名 `autox`）。兼容 [Auto.js-VSCode-Extension 1.110.0](https://github.com/kkevsekk1/Auto.js-VSCode-Extension) 实际使用的完整设备协议：WebSocket 握手、心跳、脚本运行/重跑/保存/停止、项目 ZIP 增量传输、日志和断连；支持 LAN、设备服务端直连及 ADB USB 转发。

> **范围说明**：这里的“完整”指参考插件源码中的设备协议，不代表 Android 全部管理能力。该协议没有标准的脚本执行结果 ACK、远程文件删除/下载、进程列表、截屏或 UI 树查询命令。CLI 返回 `status: "sent"` 只意味着报文写入 WebSocket，不代表脚本执行成功。点击、滑动、截图等操作可运行 AutoX JavaScript，实际权限及 API 取决于手机端。

## 安装

运行 CLI 需要 Node.js **20+**、Android 上已安装 AutoX.js；USB 模式另外需要 Android platform-tools 的 `adb`，并在手机上授权 USB 调试。

源码开发统一使用 **pnpm 11.5.3**（`packageManager` 已固定版本），该 pnpm 版本要求 Node.js **22.13+**。请先安装对应版本的 pnpm；包的运行时最低版本仍为 Node.js 20。仅维护 `pnpm-lock.yaml`，请勿混用 npm/yarn 生成其他锁文件。

```sh
# 从当前源码安装（尚未向 npm registry 发布）
cd ../pi-autox
pnpm install --frozen-lockfile
pnpm run build
pnpm test

# 不全局安装也可直接运行
pnpm exec node bin/autox-bridge.js --help
pnpm start --host 0.0.0.0

# 或不全局安装
node bin/autox-bridge.js --help

# 构建可分发 npm tarball
pnpm pack
pnpm add -g ./autox-bridge-0.1.0.tgz

autox-bridge --help
autox --version
```

## 快速开始：Wi-Fi / LAN

```sh
# 终端 1：常驻进程。默认只监听回环地址，LAN 必须显式开放
# 避免同时启用占用 9317 的 VS Code 插件
autox-bridge serve --host 0.0.0.0
```

在手机 AutoX.js 的“连接电脑”中填写电脑局域网 IP（例如 `192.168.1.20`，端口 `9317`）；需要 URL 的版本填 `ws://192.168.1.20:9317`。电脑防火墙仅允许可信设备访问 9317。启动输出及 `status` 中提供连接地址。

```sh
# 终端 2：这些命令复用终端 1 保持的设备连接
autox-bridge devices
autox-bridge run ./hello.js
autox-bridge rerun ./hello.js
autox-bridge save ./hello.js
autox-bridge stop ./hello.js
autox-bridge stop-all
autox-bridge logs --follow
```

单设备时无需指定目标；多个设备必须明确 `--device <id或唯一名称>` 或 `--all`，避免误操作。

```sh
autox-bridge --json devices
autox-bridge run ./hello.js --device 'Pixel 8'
autox-bridge stop-all --all
autox-bridge disconnect --device '<设备 ID>'
```

## USB / ADB

先在手机 AutoX.js 开启与参考插件 USB 连接兼容的服务端（设备 TCP `9317`）。仅授权 USB 调试不等于开启 AutoX 服务。

```sh
adb devices -l
# 一并启动自动发现；失败的连接每 3 秒重试
autox-bridge serve --adb
# 或对已经运行的 bridge 手动管理
autox-bridge adb list
autox-bridge adb connect <serial>
autox-bridge adb track
autox-bridge adb untrack
```

- `adb` 在 **bridge 所在电脑**执行，可用 `serve --adb-path /path/to/adb` 指定。
- 桥接创建 `adb -s SERIAL forward tcp:0 tcp:9317`，向分配的回环端口发起 WebSocket 连接。设备仍首先发送 hello。
- 只连接 `device` 状态设备，跳过 `unauthorized` / `offline`；断连或退出时清理本包创建的 forward，不删除其他工具的 forward。
- `untrack` 停止发现/重试，不中断已经建立的连接。启用 tracking 时手动 `disconnect` 的设备会被下一轮重新连接；先 `untrack` 可避免这一点。
- ADB 设备 ID 为 `adb:<serial>`；LAN 入站 ID 随每次连接生成。

设备本身开放服务端模式时也可以直接连接，不经过 ADB：

```sh
autox-bridge connect ws://192.168.1.30:9317/
```

## 脚本与项目

```sh
autox-bridge eval 'toast("Hello from CLI")' --id demo
autox-bridge stop demo --exact
printf 'console.log(device.model);' | autox-bridge run - --id inspect.js
autox-bridge run ./hello.js --id stable-script --name hello.js

autox-bridge new-project ./demo --name 'Demo'
autox-bridge save-project ./demo
autox-bridge run-project ./demo
autox-bridge save-project ./demo --full --all
```

`run` / `rerun` / `save` 默认使用本地文件绝对路径作为 `id` 和 `name`，与插件保持一致。自定义 id、stdin 和 eval 的脚本请使用 `stop <id> --exact`。空脚本允许发送，stdin 必须提供 `--id`。

项目必须包含 `project.json`。初次传输发送全部允许的文件，以后按 **设备 + 项目绝对路径** 缓存内容哈希，仅发送新增/改变文件。ZIP 作为二进制帧先发，再发送带 ZIP MD5 的 `bytes_command`；同一设备的操作串行，避免并发项目帧错配。缓存仅在发送成功后更新，重连自动全量同步；`--full` 强制全量。

- `project.json.ignore` 是相对文件/目录路径数组，**不是 glob**。例：`["build", "secret.json", "assets/cache"]`。
- 默认额外排除 `.git` 和 `node_modules`；拒绝软链接和越界 ignore。比插件的字符串前缀匹配更严格，`build` 不会误排除 `builder.js`。需要插件原样的文件选择（例如依赖项目中的 node_modules）时加 `--reference-files`：不添加默认排除项，恢复 ignore 字符串前缀匹配。请检查敏感文件，并在切换模式时考虑 `--full`。
- 单项目未压缩内容上限约 64 MiB，单 WS 帧及 HTTP 请求上限 64 MiB；base64/JSON 开销意味着原始 bytes API 的可用二进制大小更小。
- 删除文件仅返回 `removed` 和警告，**不会删除手机上的旧文件**；`--full` 也不会删除。需要用户在设备上清理。
- 发送完成没有设备 ACK，因此快照仅代表本机发送历史；怀疑设备未保存时使用 `--full`。
- 项目目录由 **bridge 主机**读取。远程 API 客户端提供的目录必须存在于 bridge 主机；单文件脚本由 CLI 本机读取并上传正文。
- 不建议把不可信进程可并发修改的目录作为项目根；软链接检查不是操作系统级沙箱。

## 日志、原始协议与程序接口

```sh
autox-bridge --json logs                   # 有界历史快照
autox-bridge --json logs --follow          # NDJSON，Ctrl-C 停止订阅
autox-bridge --json events --follow        # 包含原始文本协议消息和生命周期事件
autox-bridge logs --device '<精确设备 ID>' --since 10

autox-bridge raw '{"type":"command","data":{"command":"stopAll"}}' --device '<ID>'
autox-bridge bytes save_project ./project.zip --data '{"id":"demo","name":"demo"}'
```

`raw` 和 `bytes` 用于设备版本扩展协议，不保证未知命令得到支持。消息 ID 自动生成；原始返回通过 `events` 观察。二进制入站事件仅记录大小，不保留文件。历史默认 1000 条、最多约 8 MiB，超大消息不存入历史；重启清空。SSE `since` 是当前 bridge 进程的事件序号，不是跨进程持久游标。

```js
import { AutoXBridge, BridgeClient } from 'autox-bridge';

const bridge = new AutoXBridge({ host: '127.0.0.1', port: 9317, apiPort: 9318 });
bridge.on('event', event => console.log(event));
await bridge.start();
// 等待设备连接后：
// await bridge.execute({ action: 'run', id: 'demo', script: 'toast("hi")' });
// await bridge.stop();

// 也可仅连接一个已经运行的 bridge
const client = new BridgeClient({ url: 'http://127.0.0.1:9318' });
console.log(await client.request('/v1/devices'));
```

导出 `DeviceSession`、`packageProject`、`createProject`、`AdbManager`，以及 `autox-bridge/protocol` 中的报文辅助函数。API 文档见 [docs/protocol.md](docs/protocol.md)。

## 运行与安全

两个端口用途不同：

| 端口 | 默认绑定 | 用途 |
|---|---|---|
| 9317 | 127.0.0.1 | Android 设备 WebSocket；旧协议无认证 |
| 9318 | 127.0.0.1 | CLI HTTP 管理 API，支持 Bearer token |

**任何能访问管理 API 的人都能执行脚本、连接指定地址并读取 bridge 主机项目文件。** API token 是完全管理权限，不是多租户隔离。API 不应直接暴露公网；非回环监听必须提供 token，跨主机建议 SSH 隧道/VPN或 HTTPS 反向代理。Bearer token **不保护 9317 的设备连接**；设备端口也必须限制来源。

```sh
# 推荐通过环境变量传 token，避免出现在 shell 历史/进程参数中
export AUTOX_BRIDGE_TOKEN='replace-with-a-long-random-secret'
autox-bridge serve --host 0.0.0.0

# 客户端通过 AUTOX_BRIDGE_TOKEN 自动鉴权
export AUTOX_BRIDGE_URL=http://127.0.0.1:9318
autox-bridge --json status

# 退出时释放端口、连接、日志订阅、ADB 跟踪和自有 forward
autox-bridge shutdown
# 或向前台 serve 发送 SIGINT / SIGTERM
```

默认不提供后台脱离模式，可用 systemd、容器或其他进程管理器托管 `serve`。管理 API 和设备 WebSocket 默认都拒绝浏览器 Origin 请求，并在回环监听时校验 Host 来降低 DNS rebinding 风险。没有 token 的回环服务仍可被同机其他进程访问。

插件 `/exec?cmd=save|rerun&path=...` 是编辑器集成 HTTP 钩子，不是 Android 协议。兼容钩子默认关闭，使用 `serve --legacy-exec` 后仅在 **管理端口**开放，并同样要求 token（若配置）；`path` 支持普通文件系统路径和 `file:///...` URI。`cmd=save` 保存项目，`cmd=rerun` 在选定设备上发送 stopAll、等待 1 秒后发送 run，与插件旧钩子一致（会停止该设备其他脚本）。建议新集成直接使用 POST API。

## Agent Skill

仓库包含遵循 [Agent Skills 规范](https://agentskills.io/specification) 的 CLI 使用技能：

- 入口：[.agents/skills/autox-bridge/SKILL.md](.agents/skills/autox-bridge/SKILL.md)
- 包含设备连接、脚本/项目操作、日志、目标选择、安全边界和故障排查。
- 支持仓库级 `.agents/skills` 发现的 agent 可直接加载；其他支持 Agent Skills 的客户端可将整个 `autox-bridge` 技能目录复制到其技能目录（具体加载方式取决于客户端）。
- 该技能是仓库文档，目前不包含在 npm tarball 中；不会自动安装软件、启动服务或执行手机脚本。

## 开发与验证

核心实现位于 `src/*.ts`，启用 TypeScript `strict` 和 NodeNext ESM；`dist/` 是被 git 忽略的编译产物。直接执行 `node bin/autox-bridge.js` 前需先 `pnpm run build`；`pnpm start`、`pnpm test` 和 `pnpm pack` 会自动构建。`bin/` 仅保留无需 TS 加载器的 JavaScript 启动器，分发包可直接在 Node.js 20+ 运行。

包入口和 `autox-bridge/protocol` 子路径均附带 `.d.ts` 类型声明，导出 `BridgeOptions`、`BridgeAction`、`DeviceInfo`、`BridgeEvent` 等类型；`execute()` / `action()` 按 action 推导返回类型。扩展协议数据保持 `unknown`，使用前需检查；自定义 HTTP 路由可用 `client.request<MyResponse>('/custom')` 指定预期类型（不替代运行时校验）。

原有 JavaScript 测试改为验证 `dist/`，另有 `test/types.test.ts` 检查包入口类型与非法参数的编译期拒绝。手机端 AutoX 脚本及 `new-project` 生成的 `main.js` 仍为 JavaScript，不在本包 TypeScript 编译范围内。

```sh
pnpm install --frozen-lockfile
pnpm run check        # 严格 TypeScript 类型检查，不生成文件
pnpm run build        # 生成 dist/*.js、类型声明与 source maps
pnpm test             # 构建 + 公开类型契约检查 + 运行时回归测试
pnpm pack             # 打包前自动执行类型检查、构建和测试
```

测试通过真实本地 WebSocket/HTTP 和模拟 Android 端验证新旧握手、心跳、所有脚本报文、二进制 ZIP/MD5/增量、并发顺序、日志/SSE、多设备选择、鉴权、CLI 子进程、ADB 命令参数及 forward 清理。**没有连接真实 Android 硬件验证**；不同 AutoX 分支或版本仍需按上述步骤验收。

GPL-2.0-only。参考项目归属与协议来源见 [NOTICE](NOTICE)。
