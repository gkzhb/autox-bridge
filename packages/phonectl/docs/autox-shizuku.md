# AutoX.js 7.2.3 固定 runner：显式 Shizuku 后端

## 范围和信任取舍

用户已明确允许固定源码与临时动态请求存放于 **`/sdcard/phonectl/`**，接受有存储权限的本机应用读取、修改、替换及伪造的风险。这不是认证安全协议。没有长期密钥或 token；不要向该后端提交密码、令牌或其他敏感参数。请求删除只能缩短暴露时间，不保证其他应用没有复制它，也不是安全擦除。

runner 的 hash 检查用于发现意外改动，不能消除检查到执行的 TOCTOU。恶意 runner 可以伪造身份和命令回显。结果中的实际命令可能包含敏感参数，只通过 RUN_COMMAND 数据 argv 回传到 Termux 私有状态，不另写公共日志。

不支持任意 AutoX JS，不添加常驻网络服务，不自动申请权限、改系统设置、启动 Shizuku 或降级到其他身份。库 API 省略 backend 时，原 Termux 和 rish 默认行为不变；CLI 现默认 HTTP 优先、仅明确未提交失败才 rish（详见 [HTTP选择边界](autox-http.md#cli-auto-选择与不重复执行边界)）。`--backend rish` 强制 rish、`--as termux` 明确 Termux；文件型 `--backend autox` 用法保留，不参与自动选择。

## 安装与运行

在仓库根目录（运行时 Node>=20，开发 pnpm11.5.3/Node>=22.13）：

```sh
pnpm --filter phonectl run build
pnpm phonectl --json autox-install

# 明确选用 AutoX，仅接受 --as shell
pnpm phonectl --json exec --as shell --backend autox -- /system/bin/id -u
pnpm phonectl --json exec --as shell --backend autox -- /system/bin/printf '%s|' 'two words' "a'b" '中文🙂' '$(echo not-executed)' ''
pnpm phonectl --json shell --as shell --backend autox --script 'printf "OUT\n"; printf "ERR\n" >&2; exit 7'
```

`autox-install` 仅创建本包固定 runner、私有固定接收器和安装清单；不授予权限或启动服务。不覆盖内容不符的现有 runner/接收器。新的源码 hash 会生成新的版本文件，不批量删除历史版本。移动仓库/运行时后需重新审阅并安装。

```js
import {execute, installAutoX} from 'phonectl';
await installAutoX();
const r = await execute({
  as: 'shell', backend: 'autox',
  argv: ['/system/bin/id', '-u'], timeoutMs: 10000,
  maxOutputBytes: 16384
});
// shell 文本必须显式标识；argv 逐项 quoting，不解释参数中的 shell 语法
const s = await execute({
  as: 'shell', backend: 'autox', argv: [],
  script: 'printf "fixed\n"; exit 7', timeoutMs: 10000
});
```

需要 AutoX 已安装、Shizuku 已激活且 **AutoX 单独获权**、Termux RUN_COMMAND 原先已授权并启用 `allow-external-apps=true`。Termux rish 获权不等于 AutoX 获权。安装和运行不会代用户点击授权弹窗。

## 文件与实际 Intent 入口

- 公共固定源码：`/sdcard/phonectl/runner-v1-<源码hash前缀>.js`。
- 公共临时请求：`request-<requestId>-<attempt>.json`，原子独占 claim 标记为 `.json.claim`。
- 私有根：`~/.local/state/phonectl/autox/`（0700）；包含安装清单、固定接收器和本次 UUID 子目录。
- 私有请求状态 `pending.json`（0600），结果 `result.tmp` 原子重命名为 `result.json`；`received` 独占标记拒绝无意重复。
- 私有 `active.lock/owner.json` 限制一个活动请求，包含 PID/ID/截止时间而不含命令。异常中断/超时可能保留它，必须确认对应 Android 执行已结束后人工检查，不能盲删重试。

客户端只给实际已核实入口传固定 runner 的 file URI：

```text
$PREFIX/bin/am start
  -n org.autojs.autoxjs.v7/org.autojs.autojs.external.open.RunIntentActivity
  -d file:///sdcard/phonectl/runner-v1-<hash>.js
```

该版本 Activity 只取 URI 路径打开文件，不传递请求 extras。因此固定 runner 在专用目录发现**恰好一个**合法 UUID 请求；零个/多个时不执行。客户端看到已有请求时 fail closed，不删除别人的文件。Intent 受理并非脚本完成。

## 请求/结果协议与命令一致性

请求包含 `version:1`、随机 UUIDv4 `requestId` 与 `attempt`、绝对毫秒 `deadline`、`timeoutMs`、`maxOutputBytes` 和二选一命令：

```json
{"mode":"argv","argv":["/system/bin/id","-u"]}
```

或 `{ "mode":"shell", "script":"可信 shell 文本" }`。请求32KiB上限；AutoX结果输出默认/最多16KiB（两路 UTF-8 字节和），回调总载荷128KiB。当前输出上限是返回后的检查，不保证 Shizuku 内部采集内存严格有界，不适用于无限输出命令。

结果保留通常字段并增加仅 AutoX 返回的 `execution`：

- `execution.command`：实际 runner 采用的 mode/argv/script；
- `execution.userCommand`：argv 逐项 POSIX quoting 后的用户命令，或显式 shell 文本；
- `execution.executedCommand`：**真正传给 `shizuku()` 的同一个变量**，包含同次 UID2000 校验、超时包装和两路结束标记。

Termux 接收器根据**私有本次请求**独立生成预期值，逐项比较 mode、argv/script、userCommand、executedCommand，以及 version/requestId/attempt。不同则 `COMMAND_MISMATCH` 或 `RESULT_MISMATCH`，不作为成功返回；不能仅靠回显或结果自带 hash。该检查防串任务、转义错误和无意改写，不证明恶意 runner 诚实，也不证明最终二进制身份。

实际命令在同次 Shizuku shell 中先 `id -u`，仅 UID2000 时输出固定身份前缀并执行。用户命令在单独 `/system/bin/sh -c` 内运行，不能用 `exit` 提前退出包装。使用真实 `r.code`；保留非零退出为命令结果，`ok:true` 不等于 code0。

本机 AutoX 对无换行尾部的输出曾出现等待：包装添加每请求唯一的两路结束标记并校验/剥离，不信任缺失的结束标记。此实现是文本接口，不能宣称任意二进制保真；Node/Java UTF-8 解码和 AutoX shell 行处理仍有边界。

## 清理、并发和超时

runner 成功读取并验证请求后，在执行命令前删除该请求；异常/正常路径 `finally` 再尝试删除，回调后删除本次 claim。客户端 `finally` 也只删除**本次 UUID** 的请求/claim，撤销 pending，删除本次结果和收据目录；不会扫描删除他人请求、runner 或历史 probe。

结果只作为 JSON 数据 argv 传固定接收器，无 shell 拼接。接收器先读本次私有 pending，检查截止时间，再独占 claim，二次检查 pending 和时间，原子发布结果。成功或错误被客户端消费后不长期保留；仅一份有界的 `last-receiver-error.json` 记录时间/错误码，不记录命令和输出。

单飞锁+公共 claim 用于防正常并发，不承诺 exactly-once，也不抵御本机恶意应用/手动重复触发。客户端超时清理请求与 pending，迟到结果因状态不存在/过期被拒绝；但**不声称 Android 命令已取消**。未确认 runner 返回时保留单飞隔离锁，后续 `AUTOX_BUSY`，需要人工核实。内层 `timeout` 仅是额外执行约束，不证明整个进程树都终止。

客户端/设备强杀、电源中断、文件系统异常可能留下本次请求/锁，不能保证 finally 执行；后续不自动删除来源不明残留，不自动重试执行。

## API 的可信来源与验证界限

当前安装 APK manifest：包 `org.autojs.autoxjs.v7`，版本7.2.3/code723。APK 内 `assets/v6modules/shizuku/index.js`、`init.js` 及内置 shizuku/shell 文档确认 Rhino 全局 `shizuku(cmd)` 和 `shizuku.isAlive()`，返回 `result`（stdout）、`error`（stderr）、`code`。不是 `shell.shizuku()`。

固定官方参考：

- [7.2.3版本文件](https://github.com/autox-community/AutoX_aiselp/blob/f10667060f63f1d5069eb60635faefe3023ae07c/project-versions.json)
- [JS API](https://github.com/autox-community/AutoX_aiselp/blob/f10667060f63f1d5069eb60635faefe3023ae07c/autojs/src/main/js/v6-api/src/shizuku/index.ts)
- [Shizuku实现](https://github.com/autox-community/AutoX_aiselp/blob/f10667060f63f1d5069eb60635faefe3023ae07c/autojs/src/main/java/com/stardust/autojs/runtime/api/Shizuku.kt)
- [官方文档](https://github.com/autox-community/AutoX_aiselp_Docs/blob/49ea8c664e972337efa1975f1f0051769bb4e740/docs/rhino/advanced/shizuku.md)

此前严格私有 Unix socket 方案在真实 AutoX 连接时报 Permission denied，未修改平台策略；本版按用户确认的简化共享请求方案实现，不将它伪装为已认证私有传输。历史固定 probe 目录保留，非本协议运行所需。

## 设备验收与残留限制（已完成最小串行闭环）

真实验收结果与源码/测试证据位于本机忽略目录 `.planning/sdcard-autox/`。

- 第一轮有完整三项成功：`id -u` 返回2000、特殊argv（空格/单引号/Unicode/`$()`/空参数）按字面返回、双流固定打印与真实code7。各项请求文件结束后均为空，实际执行字符串与私有预期比对通过。
- 后续最终安装版本再测：id与特殊argv再次成功，但双流/code7这一次等待超时。不能把此前成功当作稳定性验收通过，也不能确定具体是AutoX执行还是回传/客户端事件丢失；后续将客户端结果通知处理提取到 `src/autox-result.ts`，使用可控的OS通知/文件读取接缝确定性重现：唯一rename通知在前次ENOENT读取完成前抵达，旧逻辑漏读并超时；保留dirty通知后重读可修复该类问题。实际客户端已接入该模块。**这不证明该竞态就是那次真机超时根因**。后续恢复后已用最新客户端重新验收通过，见下方。
- 超时后实际检查 `/sdcard/phonectl/` 没有请求/claim，私有根没有本次UUID目录；仅保留 `active.lock/owner.json` 隔离。后续“错误/1ms超时探针”均被 `AUTOX_BUSY` 拒绝，**不计为这些分支的真实执行验收**。成功/错误/过期请求清理由host边界测试覆盖，独立真实错误清理与刻意超时路径仍未全部完成。
- 当前真实安装：`/sdcard/phonectl/runner-v1-1a64937a8da76ca1.js`，SHA256 `1a64937a8da76ca195bceece032a5f34ec6e210b932b7ba0e140bfd46c57b351`；固定接收器 `~/.local/state/phonectl/autox/receiver-v2.mjs`，清单 `install.json`。旧版runner与历史probe未批量删除。
- 历史隔离请求：`d11256ce-44b8-4235-aa5c-27cb67765004`，attempt `1e18e334-50d0-4025-b13d-f9f848160ea0`，现已基于后续手机端进程审计定向恢复；不是仅凭Node消失而清锁。
- 恢复后最新客户端完成4项API串行验收：id2000、特殊argv、双流code7、仅stderr/code7；2项CLI验收：id退出0、双流退出7。每项实际命令比对通过，公共请求全部清理。当前无active.lock和私有UUID请求目录。证据 `recovered-acceptance.json`、`cli-acceptance.json`。
- 最新离线检查/构建/类型/语法/差异及phonectl19/19通过；此前完整workspace退出0、bridge36/36。没有把旧结果冒作重新全量运行。

这是一次最小串行验收通过，不是长时间/后台/并发稳定性保证。历史旧版本4个engine仍阻塞，见下方；不自动重启或stop-all。本文件型后端自身没有Web API或监听；后续另有独立手动短时 [内嵌 Node HTTP 后端](autox-http.md)，并非复用这里的 Rhino runner。静态可行性研究见 [Web API方案](autox-web-api-feasibility.md)。

### 本次隔离恢复依据和动作

只读恢复检查已确认：原全量验证 `final-verify.exit=0`，检查/构建/类型通过，phonectl16/16、autox-bridge36/36；原验证PID1467已不存在。这与Android隔离请求是否结束无关。安装runner的SHA256与清单、当前runner模板一致。

Termux无法读取AutoX应用日志目录；可见logcat仅有Termux app_process环境错误，无该requestId结果。`last-runner-phase.json` 没有requestId且时间早于隔离请求，不能作为结束证据。看不到AutoX进程或Node PID31383不存在都不证明Android任务停止。

用户进一步授权手机自动化诊断后，部署一次性脚手架到 `/sdcard/脚本/phonectl-diag-71df2aad1d/`，结果仅在 `/sdcard/phonectl/phonectl-diag-71df2aad1d/`。实际 `engines.all()` 和线程栈确认：engine9/10=`ec3c…`、11=`c905…`、12=`1908…`；全部属于本轮旧runner，卡在Shizuku Binder同步调用，当前`1a649…`不在列表中。对这4个精确ID+路径发出forceStop请求，立即/后续复查仍未销毁；未停止其他脚本，不能声称已取消底层命令。

另用已文档化的 `shizuku.runRhinoScript` 只读遍历 `/proc`：shell UID2000读取全部761进程、无读取失败；没有该requestId包装、固定AUTOX_STDOUT或timeout命令；服务下6个休眠sh无活动子进程。结合本次仅固定printf/exit、无后台派生行为及当前引擎不存在，作保守恢复本单次锁依据。未推广为任意任务的取消证明。`audit.json`、`process-tree.json`、`stop-owned.json`保存证据；wchan/children文件检查被拒的中间结果没有被当成成功审计。

只恢复精确ID对应owner及空锁目录，记录 `.planning/sdcard-autox/recovered-lock.json`。恢复后重新安装核对hash并串行验收。截图前景检查发现SystemUI，不是AutoX，故未采集截图/UI树，避免私人界面收集。

只有获得该具体任务结束的充分证据并确认本次ID后，才可执行以下本地状态恢复；这不是取消命令，也不会结束Android进程：

```sh
python - <<'PY'
import json, pathlib
p = pathlib.Path.home() / '.local/state/phonectl/autox/active.lock'
expected = ('d11256ce-44b8-4235-aa5c-27cb67765004', '1e18e334-50d0-4025-b13d-f9f848160ea0')
o = json.loads((p / 'owner.json').read_text())
assert (o['requestId'], o['attempt']) == expected, 'different task: stop'
assert sorted(x.name for x in p.iterdir()) == ['owner.json'], 'unexpected lock files: stop'
# Preconditions above must first be confirmed outside this script.
(p / 'owner.json').unlink()
p.rmdir()
PY
```

以上脚本描述本次已执行的精确恢复动作，不是日常自动解锁命令。以后不同ID需要重新取证，不可照抄盲删；Node消失/时间经过/请求删除都不独立构成恢复依据。晚到回调在pending消失后拒绝，不自动重建状态或释放其他任务锁；私有最后错误码不是命令终态证明。诊断JSON少量保留作证据，没有截图；只在用户明确需要时清理本次独立目录，不批量删除历史probe。
