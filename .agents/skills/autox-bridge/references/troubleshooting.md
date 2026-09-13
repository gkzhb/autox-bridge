# 故障排查与停止条件

先收集退出码、脱敏错误、CLI 版本、API 地址、设备 ID/transport 和连接模式。不得输出真实 token、全量环境变量或无关设备日志。发现同样错误后应调整诊断策略，不无限重试；最多两次有针对性的修正仍失败时报告阻塞和需要用户完成的操作。

## 1. command not found / Node 版本不满足

- 查 `node --version`、`pnpm --version`、`pnpm bin -g` 和命令 PATH；不要误从 registry 安装同名未知包。
- CLI 运行时 Node >=20；pnpm 11.5.3 源码工作流要求 Node >=22.13。
- 已有源码且依赖完整时可用 `node bin/autox-bridge.js --help`。安装、调整系统 Node 或 shell 配置需符合用户授权范围。

## 2. fetch failed / ECONNREFUSED

- 先确认失败的是管理 API（默认 HTTP 9318），不是手机 WebSocket（默认 WS 9317）。
- 确认已有 bridge 是否在运行、API 地址是否指定正确。若用不同 api-port，配套设置 --url 或 AUTOX_BRIDGE_URL。
- 不通过反复启动多个 serve 解决。确实未运行且已获授权时才启动前台/受控后台进程。
- 原始错误不足时查看自己启动的 bridge stderr，避免读取无关进程配置。

## 3. EADDRINUSE

- VS Code AutoX 插件或另一个 bridge 可能占用 9317/9318。
- 尝试查询已知管理地址的 status；先确认端口归属，不能直接 kill 不明进程。
- 用户允许时停止冲突服务，或选不同的设备/管理端口并同步客户端地址。修改监听端口不改变 ADB 设备端 9317。

## 4. API 401 / Unauthorized

- 确认 server 与 client 都通过同一安全来源注入 AUTOX_BRIDGE_TOKEN，只检查是否配置，不打印值。
- API 拒绝 Origin；回环监听校验 Host。该接口用于 CLI/受信服务，不通过关闭检查来接纳不可信网页。
- 非回环 API 强制 token。不要为了调通而移除保护、暴露公网或把 token 放入 URL。

## 5. devices 是空数组 / hello timeout

- API 可访问不等于手机已连接。手机必须发送 AutoX hello 才会列入 devices。
- LAN：确认手机填写电脑真实 LAN IP，网络互通、端口匹配、防火墙仅允许可信设备；不能填 0.0.0.0/127.0.0.1。
- 直连/ADB：确认手机 **AutoX 服务端**已经开启；普通 Android USB 调试不够。
- 默认 hello 超时 10 秒；未知 WebSocket 服务可能能连上 TCP 却不懂 AutoX 协议。不要把任意端口的成功连接当作兼容。
- 需要用户手动打开手机设置/确认权限时，明确请求该步骤；没有设备时不宣称真机验证完成。

## 6. ADB unauthorized / offline / executable missing

```sh
adb devices -l
autox-bridge adb list
```

- USB 调试和授权弹窗必须由用户完成。offline 检查线缆、设备解锁和调试状态。
- `adb` 在 bridge 主机执行；远程 CLI 本机装 adb 不解决远端 executable missing。bridge 启动时用 --adb-path 指定路径。
- `adb connect <serial>` 是 autox-bridge 子命令，做 USB forward；不要和 platform-tools 的 `adb connect <host:port>` 混淆。
- tracking 仅连接 `device` 状态，约每 3 秒重试；不要另外高频重复 connect。
- 不运行 `adb forward --remove-all`，不自动 `adb kill-server`；这些影响其他工具。包只清理自有 forward，持续 daemon 错误可能仍留下映射，应按明确 serial/端口调查。

## 7. 多设备、重复名称、断连后 ID 失效

- 重新读取 `--json devices`，选择精确 id；多个设备时不自动补 --all。
- LAN 重连会生成新 ID；ADB 使用 adb:SERIAL。名称可由设备提供且可能重复或改变。
- 保持断开需要先评估是否关闭 tracking，再对指定设备 disconnect。untrack 影响自动发现，但不停止现有会话或脚本。

## 8. 已发送但手机没反应

- `sent` 不是设备成功 ACK。读取本次专属日志标记、AutoX 手机日志或用户可见结果。
- 用户设备的无障碍、悬浮窗、存储等权限与 API 版本可能影响脚本；不要自动授予扩大权限。
- 检查实际脚本 id、目标设备及传入正文。stop 默认解析绝对文件路径，自定义 id 必须 --exact。
- 对可能产生副作用的脚本，不因没 ACK 而自动重发。先确认是否已执行；不能把超时当作“肯定没执行”。

## 9. 项目文件未同步 / 旧文件仍存在

- folder 在 bridge 主机，必须包含 project.json；检查 ignore、默认排除、软链接和体积限制。
- ignore 是路径不是 glob。需要发送 node_modules 时先审查目录，再考虑 --reference-files，不直接解除所有过滤。
- 发送缓存仅代表本机发送历史；用户确需重发时用 --full。
- 本地 removed 不会远程删除，--full 也不会删除。不能伪造删除命令；请用户确认设备端清理方式和范围。
- 若目录包含敏感信息或不可信进程可并发修改，停止上传并先整理安全的项目副本。

## 10. 日志流长期不结束 / 历史缺失

- --follow 就是常驻订阅，Ctrl-C 结束自己的订阅；不要 shutdown 整个 bridge 来退出日志。
- 自动化优先无 follow 的快照；有持续观察需求时用明确期限的受控任务。
- 日志有界且不持久；重启清空和序号重置，超大消息不保留。慢消费者可能被断开，不保证无限重放。

## 最终报告模板

- 目标：设备 ID、transport（名称必要时脱敏）。
- 动作：脚本/项目 id、所用命令，是否有广播或停止操作。
- 主机结果：退出码、每个目标的 sent/error、必要的 messageId。
- 设备证据：本次日志标记或用户确认；没有时明确“执行结果未确认”。
- 生命周期：是否保留 bridge、tracking 或日志订阅，自己启动的进程如何停止。
- 阻塞：需要用户完成的授权/设置，以及不能从当前环境验证的事实。
