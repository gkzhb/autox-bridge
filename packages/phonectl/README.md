# phonectl

Termux **本地**手机控制 CLI 核心（0.1.0），不自带电脑端 SSH 客户端、不 SSH 回自身，不依赖 autox-bridge、ADB 或 WebSocket，不启动网络监听。电脑可以通过既有 SSH 调用手机上的命令。

## 当前范围

- `--help` / `--version`。
- `status`：只读查询设备型号/Android、Termux 身份与环境、rish 文件是否存在、AutoX 包是否可观察。**不调用 rish、不启动 AutoX、不申请权限、不唤醒屏幕**。无法确定的授权/运行/入口状态返回 `unknown`，查询不到型号返回 `null`。
- `exec --as termux -- <argv...>`：本地直接 argv 执行，不经 shell 拼接，保留输出及命令退出码。
- `exec -- <argv...>`：默认 Android shell 身份（UID2000），HTTP 优先，仅确定尚未提交执行时才 fallback 到已有 rish；不自动启动 HTTP/AutoX/Shizuku。`--as shell` 保留为同义显式身份选择。
- `exec --backend rish -- <argv...>`：强制已有 `~/rish`（可用 `PHONECTL_RISH` 或 API `rishPath` 指定），**完全跳过 HTTP**；同次调用内确认 UID2000 后执行，缺失/授权/身份/结果未确认时报错，不降级为 Termux。
- `shell --script <text>`：相同 HTTP 优先策略；`--backend rish` 强制 rish，`--as termux` 保留 Termux。显式解释可信 shell 文本，与 argv 接口分开。
- **实验性 AutoX Node HTTP 后端**：`http-install` 安装短时 `.mjs` 回环服务，手动 Intent 启动并私有配对后，使用 `exec/shell --as shell --backend autox-http`。Node Java异步桥接直接执行Shizuku，所有HTTP接口Bearer鉴权；也可用 `--backend autox-http` 禁用 fallback、强制 HTTP。
- **实验性显式 AutoX 后端**：`exec/shell --as shell --backend autox`；先运行 `autox-install` 安装固定 runner。用户已接受临时请求放 `/sdcard/phonectl/` 的风险，结果回传 Termux 私有目录；不同于认证安全通道。恢复诊断后已完成一轮4项API与2项CLI串行真机验收，请求均已清理；此前有超时记录，长时间/并发/后台稳定性未验收，超时仍 fail-closed 隔离。

**当前真机限制：**iQOO Z1 的无 PTY rish 历史探针复现输出流向变化、stderr marker 缺失和 `exit 7` 外层返回 0。当前适配已将 rish 外层 stdout/stderr 按 Node 事件抵达顺序合并后解析身份/结果帧；这不恢复缺失字节，也不保证跨 pipe 的原始全局顺序。结果帧内命令的 stdout/stderr 仍分开，Termux 后端不合并；退出码 framing 本轮未改。缺身份或完整结果时仍明确失败，不以 rish 外层 0 伪造成功。本轮强制 rish `id -u` 和 HTTP 关闭后 auto→rish `id -u` 均成功（UID2000、实际 backend rish），但不等于双流/非零/长期稳定性全量验收通过；不自动修改配置、授权或启动服务。

## 在仓库根目录开发

Node.js 运行时 >=20；源码工具链沿用 pnpm 11.5.3 / Node >=22.13。

```sh
pnpm install --frozen-lockfile
pnpm --filter phonectl run build
pnpm phonectl --help
pnpm phonectl --json status
pnpm phonectl --json exec --as termux -- pwd
pnpm phonectl exec --as termux -- /system/bin/id
pnpm phonectl --json exec --as termux -- printf '%s\n' 'two words' '中文🙂'
pnpm phonectl --json shell --as termux --script 'printf out; printf err >&2; exit 7'

# 默认 HTTP 优先，明确安全的未提交失败才 fallback rish
pnpm phonectl --json exec -- id -u
pnpm phonectl --json shell --script 'printf "OUT\n"; printf "ERR\n" >&2; exit 7'
# 强制 rish，跳过 HTTP；其完整结果可能仍未确认
pnpm phonectl --json exec --backend rish -- id -u

pnpm --filter phonectl run check
pnpm --filter phonectl test
pnpm run pack:phonectl
# 从根运行时产物 phonectl-0.1.0.tgz；不执行发布
```

`pnpm phonectl` 直接运行构建产物，不改变当前工作目录，因此本地相对参数以调用目录解释。`node packages/phonectl/bin/phonectl.js ...` 等价。安装后的 `phonectl` 不需要 TS 加载器。

## 结果与错误契约

`--json` 应放在命令之前；stdout 只输出一份 `{ok,result}` 或 `{ok:false,error:{code,message,details?}}`。工具诊断放 stderr；命令自己的 stdout/stderr 在 JSON `result` 字段内。普通 exec 模式直接写回各输出流。输出按 UTF-8 文本解码，不提供二进制管道或交互 stdin/TTY。

`ok:true` 表示拿到了命令结果，**不表示命令退出码为 0**；CLI 退出码沿用命令 `exitCode`。工具错误退出 1，与结果内命令退出码区分。`exec` 必须显式使用 `--` 分隔参数，NUL 和空 executable 拒绝。

CLI 默认超时 30000ms。默认 auto/强制 HTTP 的 `--timeout` 为 1..60000ms、输出默认/最多16KiB；Termux、rish 和文件型 AutoX 超时为1..3600000ms。下面的进程终止及输出文件说明针对 Termux/rish；HTTP 细节见专门文档。超时 CLI 退出 124，`timedOut:true, completion:"unconfirmed"`。超时会终止本工具持有的直接子进程，但**不证明后代或 Android 远端进程已停止**，不会自动重试。shell 后端启动与结果传输最多另留 2 秒；没有身份/完整结果时返回工具错误，而不是伪造命令成功。命令正常返回 124/137 时 shell 后端也保守标为未确认，不能精确区分其主动返回和后端 timeout。

Termux/rish 默认 stdout+stderr 上限 1 MiB，API 可调至最多 4 MiB；auto 即使 fallback 到 rish，也先按 HTTP 的16KiB和60秒上限校验，不能借 fallback 绕过参数校验。超出返回 `OUTPUT_LIMIT`，不承诺后代终止。shell 后端在 shell-owned `/data/local/tmp/phonectl.<随机>` 目录捕获输出（0700，文件0600），有限额/超时并尝试按所有权清理；后端进程崩溃或被系统杀死可能留下该目录，不自动扫描或广泛清理。它只存命令输出，不存 argv/凭据。

稳定工具错误：`INVALID_ARGUMENT`、`COMMAND_UNAVAILABLE`、`SHIZUKU_UNAVAILABLE`、`IDENTITY_MISMATCH`、`RESULT_UNCONFIRMED`、`OUTPUT_LIMIT`、`INTERNAL_ERROR`。shell 后端使用固定 POSIX quoting 将每个 argv 字面量编码到 rish 的 `-c` 接口；显式 shell 模式才解释用户脚本文本。这个封装不是对恶意 shell 权限进程的安全沙箱。

## AutoX 范围与未支持项

**本版未实现** `script run`、`task inspect`、`task logs` 或取消；也没有 push/pull、电脑端 SSH、守护进程、重启恢复或屏幕解锁。

固定 runner 仅执行请求中的 Shizuku shell 命令，不执行用户提供的任意 AutoX JS。请求含 version、唯一 requestId/attempt、deadline、输出限额和明确 argv/shell 模式；成功读取校验后尽早删除，runner 与客户端 finally 仅清理本次请求。Intent 受理不是完成。超时撤销本次私有 pending 并清理公共请求，但不证明 Android 命令已停止，保留单飞隔离锁并拒绝后续并发；不提供自动重试或 stop-all 取消。

结果附 `execution.command`、quoting 后的 `userCommand` 和实际 `shizuku()` 使用的完整 `executedCommand`，与客户端私有预期严格比对。防止无意串任务/改写，不防可篡改 runner 伪造回显。切勿提交秘密或敏感参数；不能将公共文件删除等同安全擦除。

## AutoX 安装、调用与限制

```sh
pnpm phonectl --json autox-install
pnpm phonectl --json exec --as shell --backend autox -- /system/bin/id -u
pnpm phonectl --json shell --as shell --backend autox --script 'printf "OUT\n"; printf "ERR\n" >&2; exit 7'
```

设备先前因未确认完成的执行隔离；后续通过AutoX引擎列表、线程栈及shell UID完整进程树诊断，定向恢复了该ID，最新4项API与2项CLI串行探针均通过，当前无请求/结果目录或隔离锁。4个旧版本引擎仍阻塞在Shizuku Binder，定向停止请求未使其销毁，未重启服务或stop-all。当前属于**已通过最小验收的实验性后端**，不能称为长时间稳定性通过；详见方案中的证据与残留限制。

API、完整协议、清理/输出限制和版本来源见 [AutoX Shizuku 后端](docs/autox-shizuku.md)。文件型 `--backend autox` 仍只显式选用，不参与 auto 选择；Termux 仍需 `--as termux`。发布清单包含 `runner/` 与 `docs/`，打包验证本轮未重跑。[历史Web API可行性研究](docs/autox-web-api-feasibility.md) 已补充独立Node模式更正；用户后续授权的实际实现、私有key配对、手动启动/停止、SSH隧道与验证限制见 [AutoX Node HTTP后端](docs/autox-http.md)。

### 默认选择、兼容与 API

```sh
phonectl exec -- id -u                         # HTTP 优先，安全时 rish
phonectl exec --backend rish -- id -u          # 强制 rish，绝不访问 HTTP
phonectl exec --as termux -- id               # Termux 身份
phonectl shell --script 'id -u'               # 同样 HTTP 优先
phonectl shell --backend rish --script 'id -u'
phonectl exec --as shell --backend autox-http -- id -u  # 旧参数保留，强制 HTTP
phonectl exec --as shell --backend autox -- id -u       # 旧文件型 runner 保留
```

`--backend auto` 是 CLI shell 默认值。`--as termux` 与任意 `--backend` 组合均 `INVALID_ARGUMENT`，不能静默改变身份。CLI 旧 `--as shell` 参数仍接受，但省略 backend 现在采用 HTTP 优先；需要原 rish 路径请加 `--backend rish`。旧 CLI 省略 `--as` 曾默认 Termux，现改为 shell；Termux 调用必须显式 `--as termux`。

库 API **不改变省略 backend 的旧契约**：`execute({as:'termux',argv:['id']})` 仍本地执行，`execute({as:'shell',argv:['id']})` 仍原 rish（返回旧 `backend:'shell'`）。新策略需显式 `execute({as:'shell',backend:'auto',argv:['id','-u']})`；强制 rish 用 `backend:'rish'`。脚本可用 `backend:'auto', argv:[], script:'id -u'`，强制 rish 则沿用 argv `['/system/bin/sh','-c','id -u']`。

auto 仅在私有配对不存在/有效配对已过期，或 **health 预检连接明确 `ECONNREFUSED`** 时转 rish。畸形配对、401/403、busy、协议错误、预检超时/reset/未知失败均不 fallback。开始尝试提交 POST 后，无论连接报错、读超时、unknown、命令/身份校验失败，均不 fallback；命令非零退出是结果，也不 fallback。health 成功不能证明 POST 未发生；不自动重复执行、不保证取消/exactly-once。

JSON `result.backend` 记录实际 `'autox-http'`、`'rish'`、`'termux'` 或 `'autox'`，不会返回 `'auto'`；发生 fallback 时附 `fallback:{from:'autox-http',reason:'HTTP_NOT_PAIRED'|'HTTP_EXPIRED'|'HTTP_UNAVAILABLE'}`。rish fallback 若失败，错误 `details` 记录 `backend:'rish'` 和原因；不会输出配对 key。普通文本模式仍只透传命令输出；需要 backend 证据使用 `--json`。

### 手动短时 HTTP 服务

```sh
pnpm phonectl --json http-install --lifetime 120000
# 仅对返回的本次 server.mjs 路径执行 Termux am/RunIntentActivity，见上方文档
pnpm phonectl --json exec --as shell --backend autox-http --timeout 10000 -- /system/bin/id -u
pnpm phonectl --json shell --as shell --backend autox-http --timeout 10000 --script 'printf "OUT\n"; printf "ERR\n" >&2; exit 7'
# 结束时对同次返回的 stop.js 执行 Intent，并确认端口已关闭
```

API key 在AutoX和Termux私有目录，不输出到CLI；公共源码仍可被篡改，因此key不解决源码完整性。只绑定127.0.0.1系统分配端口，非LAN/WAN。手动停止和期限watchdog均不证明Android命令已取消，后台/休眠不保证硬实时。验证结束默认停止本次监听，非系统常驻服务。

GPL-2.0-only，见 LICENSE / NOTICE。
