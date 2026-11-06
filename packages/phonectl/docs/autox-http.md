# AutoX 内嵌 Node `.mjs` HTTP 后端（实验性、手动短时启动）

## 架构与版本

本机 AutoX.js **7.2.3 / code723** 的 `.mjs` 引擎实测为 **Node v24.11.1**，不是 Termux Node v25.8.2，也不是现有 Rhino `.js` runner。

```text
phonectl exec -- ...（CLI 默认 auto）/ --backend autox-http（强制）
  → 127.0.0.1 HTTP + Bearer key
  → AutoX 内嵌 Node node:http
  → java.invokeIo(AutoX Shizuku wrapper, runShizukuShellCommand)
  → 已有 Shizuku user service，UID2000
```

执行路径为 **Node 直接调用 Java Shizuku**，不经过sdcard动态请求、旧固定runner、rish或另一个Rhino执行器。仅私有初次配对使用短暂Rhino helper构造Intent的Java `String[]`（当前Node代理把数组转ArrayList，直接构造未通过）；helper在AutoX私有目录生成，RUN_COMMAND提交后finally删除。

可信接口依据及静态调查见 [可行性研究](autox-web-api-feasibility.md)。实际内嵌Node、direct Shizuku、鉴权、命令和关闭证据位于本机忽略目录 `.planning/autox-http/`；不把静态能力当作真机结果。

## 安装、手动启动和停止

在Termux仓库根目录：

```sh
pnpm --filter phonectl run build
pnpm phonectl --json http-install --lifetime 120000
```

命令返回新实例的 `server`、`stop`、`publicDirectory`、源码hash和寿命，**不返回API key**。寿命可配置10000..600000ms（默认120秒），地址固定 `127.0.0.1`、端口传0由系统分配，不抢占已有端口，不绑定LAN/WAN。

使用返回的具体路径运行，不用通配符批量执行历史文件：

```sh
"$PREFIX/bin/am" start \
  -n org.autojs.autoxjs.v7/org.autojs.autojs.external.open.RunIntentActivity \
  -d file:///sdcard/phonectl/http-本次UUID/server.mjs
```

已通过授权的 `RUN_COMMAND` 会自动将本次端口/key/到期时间写到Termux私有配置。启动返回0不是完成；应先检查本次 `listening.json`、配对和health。当前不自动申请AutoX/Shizuku/Termux权限，不处理授权弹窗。

执行：

```sh
pnpm phonectl --json exec --timeout 10000 -- id -u  # 默认 HTTP 优先，安全未提交失败才 rish
pnpm phonectl --json exec --backend rish --timeout 10000 -- id -u  # 强制 rish，零 HTTP 请求
pnpm phonectl --json exec --as shell --backend autox-http --timeout 10000 -- /system/bin/id -u
pnpm phonectl --json exec --as shell --backend autox-http -- /system/bin/printf '%s|' 'two words' "a'b" '中文🙂' '$(echo literal)' ''
pnpm phonectl --json shell --as shell --backend autox-http --timeout 10000 \
  --script 'printf "OUT\n"; printf "ERR\n" >&2; exit 7'
```

API：

```js
import {installHttp, execute} from 'phonectl';
const installation = await installHttp(120000); // 仅安装，启动仍使用上面的Intent
const result = await execute({
  as: 'shell', backend: 'autox-http',
  argv: ['/system/bin/id', '-u'], timeoutMs: 10000,
  maxOutputBytes: 16384
});
```

停止时运行**同一安装返回的 `stop` 文件**：

```sh
"$PREFIX/bin/am" start \
  -n org.autojs.autoxjs.v7/org.autojs.autojs.external.open.RunIntentActivity \
  -d file:///sdcard/phonectl/http-本次UUID/stop.js
```

它只匹配该次完整 `NodeScript@.../server.mjs` 源路径，并清理本次engineId对应的私有watchdog；没有HTTP kill接口、stop-all或服务重启。Intent受理是异步的，需等待 `stop-requested.json` 后再确认端口拒绝连接；收据本身不是进程取消证明。

### 寿命与关闭边界

实测本机内嵌Node timer不能单独作为可靠的墙钟到期保证，因此实现三层约束：Node关闭timer、每个请求的绝对到期检查（到期503并close）、AutoX私有短时Rhino watchdog按精确engineId+完整路径请求停止本次server。watchdog不是常驻服务或自启动任务，正常结束删除其源码。

手机休眠/调度延迟仍可能使关闭晚于名义期限，不能宣称硬实时。关闭监听也不证明进行中的Shizuku命令或进程树取消；不对未知完成自动重试。不启动长期服务，不承诺后台/开机存活。验证结束默认定向停止本次监听并检查端口释放。

## Key存储、配对与轮换

- 每次手动启动使用 `node:crypto.randomBytes(32)` 生成32随机字节、64位hex key；不使用时间戳/UUID当key。
- AutoX私有保存：`context.getFilesDir()/phonectl-http/api-key`（本机 `/data/user/0/org.autojs.autoxjs.v7/files/phonectl-http/api-key`），0600。
- 私有一次性helper：同目录 `pair-once.js`，0600，提交后finally删除；不写公共源码。
- Termux配对接收器：`~/.local/state/phonectl/http/pair-v1.mjs`；数据通过Intent argv提交固定接收器，不拼shell。
- Termux配置：`~/.local/state/phonectl/http/pairing.json`，0600；根目录0700，字段为版本、baseUrl、key、expiresAt。CLI自动读取，不需将key放命令行或输出。
- 每次启动生成新key并更新私有配置。先停止旧实例再启动新的，不支持多服务共享一个配对文件。旧实例持有的旧key不会因文件覆盖自动撤销；必须关闭旧实例。不要将配对文件加入Git或日志。
- pairing是本机已有授权RUN_COMMAND的实用传递，不是新建PKI或调用方强认证。Termux同UID应用/已获RUN_COMMAND能力的应用仍可能影响本地配置；不把它描述为对抗恶意本机应用的安全边界。
- 公共server源码可被有权限的应用替换后以AutoX身份读取私有key。**API key不解决公共源码完整性/TOCTOU**。本方案沿用用户接受的可信本机应用模型，不适合不可信设备。

公共目录只含不带key的固定源码、监听/阶段/关闭收据；没有动态命令请求或输出文件。命令/结果保留在有界server内存与客户端返回中，key和完整环境不写日志。

## HTTP协议与限额

所有接口均要求 `Authorization: Bearer ...`；固定长度后用 `timingSafeEqual` 比较；无/错key401。拒绝重复Authorization、Origin、Transfer-Encoding、非127.0.0.1 Host；key不放query。Host允许SSH隧道本地高位端口，不代表允许LAN。

| 接口 | 语义 |
|---|---|
| `GET /v1/health` | version、busy、transport；需要鉴权 |
| `POST /v1/executions` | JSON请求，接收后202；不是执行完成 |
| `GET /v1/executions/<requestId>?attempt=<attempt>` | running/completed/failed/unknown及绑定结果；不自动重新执行 |

请求结构与固定后端一致：version1、UUIDv4 requestId/attempt、deadline、timeoutMs、maxOutputBytes、`{mode:'argv',argv:[...]}`或显式`{mode:'shell',script:'...'}`。不允许JS eval、任意callback、任意文件路径或远程kill。

- 请求体32KiB、header8KiB、请求读期限3秒、HTTP头/请求期限、最多8连接；拒绝歧义/超大输入。
- 超时1..60000ms、输出默认/最多16KiB（stdout+stderr UTF-8），响应上限128KiB。
- **单飞worker**，新任务busy返回409；health和结果查询不等待worker。同步Binder调用放Java IO线程，Node控制事件循环不被直接阻塞。
- 结果最多32个，完成后TTL60秒清理；存在生命周期/调度延迟，客户端查询时也按绝对deadline校验。不是持久任务调度或exactly-once。
- 相同ID+相同请求返回已有状态，改写则409，不重新执行；未知/超时状态不伪造返回码。挂起worker保持busy，迟到成功不覆盖unknown，不自动重试。
- 输出限额是Shizuku返回后的检查，不保证内部采集内存严格有界，禁止无限输出命令。

同次shell上下文先校验UID2000，随后独立子shell运行用户命令；采用真实 `r.code`，124/137保守标记未确认。追加并剥离两路结束标记以适配AutoX行式结果，不宣称任意二进制/所有文本情况字节保真。

结果包含原始命令结构、quoting后userCommand和实际传给Shizuku的executedCommand。客户端依据本次私有预期独立校验mode/argv/script/执行字符串和requestId/attempt；改写则拒绝。它防意外转义/串任务，不证明恶意server诚实或最终二进制身份。库 API 省略 backend 时旧Termux/rish行为不变；CLI 默认选择改为下述 auto，文件型 autox 仍仅显式选用。

## CLI auto 选择与不重复执行边界

`phonectl exec -- id -u` / `phonectl shell --script 'id -u'` 默认 `as:shell, backend:auto`；`--as shell` 兼容。`--backend rish` 完全跳过配对读取和 HTTP，`--backend autox-http` 仍强制 HTTP，不 fallback。`--as termux` 必须不带 backend，否则明确拒绝。旧 `--backend autox` 固定文件 runner 不参与自动选择。

库 API 默认不变：`execute({as:'shell',argv:['id']})` 仍 rish、旧结果 backend 为 `shell`。只有显式 `backend:'auto'` 启用 HTTP 优先；`backend:'rish'` 强制并报告实际 backend `rish`。`backend:'auto', argv:[], script:'id -u'` 支持脚本；rish 显式脚本沿用 argv `['/system/bin/sh','-c','id -u']`。

自动路径先校验命令/60秒/16KiB/32KiB请求上限，读取并校验私有配对，再鉴权 `GET /v1/health`，验证协议及 busy，然后最多一次 `POST /v1/executions`。仅下列未提交证据允许 rish：

- 配对文件 `ENOENT`（不是其他读取错误），`HTTP_NOT_PAIRED`；
- 结构合法但已过期配对，`HTTP_EXPIRED`；
- health fetch 明确 `ECONNREFUSED`（AggregateError 须所有原因均为拒绝连接），`HTTP_UNAVAILABLE`。

畸形/非回环配对、health超时/reset/未知、响应体读取失败、busy、401/403、协议错误，不 fallback。**调用 POST fetch 就跨过保守提交边界**：即使该次 POST 报 ECONNREFUSED，也无法由错误阶段证明未提交，因此不 fallback；响应/查询超时、unknown、绑定/命令/身份错误、输出限制均不 fallback。成功 health 不是“命令尚未提交”的证据。命令真实非零退出返回原结果，不切换后端、不重试。

成功结果记录实际 `backend:'autox-http'|'rish'`，fallback 增加 `{from:'autox-http',reason:<上列错误码>}`；fallback rish 失败时错误 details 同样记录实际 backend/原因。部分 HTTP 错误带 `phase:'pairing'|'preflight'|'submit'|'result'`、`executionSubmitted:false|'unknown'|true`、`fallbackSafe` 说明证据，不含 key。未标记的校验错误也绝不重试；不能把任意同名错误码当安全 fallback。

不自动启动服务、修权限或重启 Shizuku；HTTP 关闭时可能安全 fallback 至 rish，但 rish 当前真机限制仍存在，失败如实上报。HTTP 普通调用执行不是监听安装/启动。auto 优先部分的验证记录见 `.planning/cli-auto/`，之前段落的历史数字仅指之前版本。

## 上位机访问：SSH隧道

优先直接在SSH内运行phonectl，它自动读取手机私有配对，不需复制key。若需上位机HTTP调用：

1. 只从本次公共 `listening.json` 读取端口P（不含key）。
2. 建立已有SSH加密隧道：

```sh
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:18765:127.0.0.1:P iqoo
```

3. 经SSH将私有配对安全复制到上位机0700目录的0600文件（不输出原值），客户端在内存读取key并设置Authorization；连接地址改为 `http://127.0.0.1:18765`。不要将key直接放curl命令行、shell历史或query。该远程客户端/隧道在本轮未另做真实验收，手机本机phonectl已实测。

loopback仍可能被其他手机应用访问，鉴权不可省。LAN/WAN或明文HTTP会暴露key和执行内容，本轮不提供此部署；若未来需要LAN，须另行设计TLS及可信代理/访问控制。

## 本轮 CLI auto 验收（后续增量）

本轮证据在 `.planning/cli-auto/`（Git忽略）：`device.json` / `device.exit` 记录实际远端退出0。手动短时实例 `/sdcard/phonectl/http-5e86dd9d-e6b1-4f2b-8e04-e484d012ae5a/server.mjs`，SHA256 `ce2378bd4360a0f6f83519436f87c7b32255f3f82c300b9aa873b838ac448025`，内嵌Node24.11.1、engine60、127.0.0.1:44893。

- 4项真实HTTP命令通过：默认 CLI `exec -- id -u` →2000、API auto特殊argv字面保留、默认 CLI shell双流/真实退出7、旧显式 `--as shell --backend autox-http` id2000。
- 显式Termux id返回UID10224；强制 `--backend rish` id2000成功。该rish成功只证明本次id，不推翻历史双流/非零/长期稳定性限制。离线畸形配对+HTTP请求记录另验证显式rish完全跳过HTTP。
- 结束时精确stop仅匹配本次engine60及源路径，有 `stop-requested.json` 收据；独立TCP实测44893拒绝连接。随后默认CLI确实选择rish、id2000，附 `fallback:{from:'autox-http',reason:'HTTP_UNAVAILABLE'}`。历史7个端口亦复核关闭。没有保留试用监听，未重启/强停其他脚本或Shizuku。
- 危险边界仅离线注入：预检拒绝连接可fallback；预检reset/超时/未知/混合原因/响应体错误/鉴权/busy/协议错误，以及提交或结果阶段拒绝连接/超时/unknown/改写/身份失败均不fallback，POST最多一次。没有制造真实长期挂起/有副作用命令。未重写原rish身份/结果/exit封装。

本轮完整workspace check/build/type contracts/tests退出0：phonectl29/29、bridge36/36。后续新增1项fallback错误元数据断言后，并发整包曾29/30失败，原HTTP客户端3秒墙钟deadline耗尽；独立客户端诊断1/1通过，观察到启动窗口Date.now约9898ms而单调时钟约642ms，请求本身75ms。这是墙钟/单调时钟差异的直接证据，不足以证明那次失败精确瞬间的根因；未为测试修改生产deadline或fallback语义。最终串行check/build/type contracts和phonectl30/30全部通过、远端退出0，收据见 `.planning/cli-auto/final-serial.*`。

下文是之前HTTP实现的历史验证记录，不冒充本轮全部重跑。

## 验证状态

已实测内嵌Node v24.11.1加载node:http、回环动态端口、直接Java异步Shizuku UID2000；私有helper配对成功。真机无/错/对key分别401/401/200，无效400、超大413；id、特殊argv、双流真实code7和显式CLI code7均有记录。早期生命周期/停止验收存在timer延迟和异步检查过早的问题，不能把launch退出0当完成。最终生命周期实例 `/sdcard/phonectl/http-a2c7105b-3da5-4790-b852-01e7d14c442e/server.mjs`，SHA256 `3c1d6147a1ef855dac7914bcefcf4c56c751a23adf89e10650ac866afd8ac8c9`，模块源码与当前仓库一致，监听127.0.0.1:34141。名义10秒寿命实际约68秒才自动关闭；随后精确stop清理watchdog，TCP实测ECONNREFUSED。最终全部记录端口35273/34591/36979/36393/39817/34141均关闭，初始44709探针亦有关闭记录且对应engine不在列表。AutoX私有目录只剩api-key，无pair-once/watchdog文件；Termux配置0600，目录0700。没有保留试用监听。

功能验收实例 `/sdcard/phonectl/http-2216de7a-9738-48cd-bb46-e496c96441e2/server.mjs` 使用同一直接执行协议，鉴权、id/特殊argv/双流code7/API及CLI code7均通过；其停止脚本首次检查过早记录失败，后续独立TCP检查确认为拒绝连接。最后生命周期/绝对到期补丁只重验关闭路径，未把旧功能结果称为最新版本完整重跑。

全workspace检查/构建/类型和phonectl23/23、bridge36/36实际远端退出0；最后关闭补丁后的受影响包检查/构建/类型/phonectl23/23与语法/差异检查也退出0。busy/worker挂起/超时和改写拒绝由离线测试验证，没有故意制造真实长期未知命令。

离线覆盖鉴权、输入、单worker busy/health、超时unknown/迟到不覆盖、命令解码、客户端改写拒绝及配对配置限制。未测试恶意Android应用、长期负载、冷启动/休眠后台稳定性、真实无限输出、TLS或LAN。旧4个历史Binder阻塞engine仍保留，不在本次服务关闭范围内。
