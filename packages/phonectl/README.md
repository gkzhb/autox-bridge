# phonectl

Termux **本地**手机控制 CLI 核心（0.1.0），不自带电脑端 SSH 客户端、不 SSH 回自身，不依赖 autox-bridge、ADB 或 WebSocket，不启动网络监听。电脑可以通过既有 SSH 调用手机上的命令。

## 当前范围

- `--help` / `--version`。
- `status`：只读查询设备型号/Android、Termux 身份与环境、rish 文件是否存在、AutoX 包是否可观察。**不调用 rish、不启动 AutoX、不申请权限、不唤醒屏幕**。无法确定的授权/运行/入口状态返回 `unknown`，查询不到型号返回 `null`。
- `exec --as termux -- <argv...>`：本地直接 argv 执行，不经 shell 拼接，保留输出及命令退出码。
- `exec --as shell -- <argv...>`：使用已有 `~/rish`（可用 `PHONECTL_RISH` 或 API `rishPath` 指定）；同次后端调用内先确认 `id -u = 2000`，再执行。缺失、授权/身份未确认时明确失败，**不降级**。
- `shell --as termux|shell --script <text>`：明确选择解释 shell 脚本文本，与 argv 接口分开，仅运行可信脚本。

**当前真机限制：**iQOO Z1 的无 PTY rish 探针复现输出流向变化、stderr marker 缺失和 `exit 7` 外层返回 0。当前适配已将 rish 外层 stdout/stderr 按 Node 事件抵达顺序合并后解析身份/结果帧；这不恢复缺失字节，也不保证跨 pipe 的原始全局顺序。结果帧内命令的 stdout/stderr 仍分开，Termux 后端不合并；退出码 framing 本轮未改。缺身份或完整结果时仍明确失败，不以 rish 外层 0 伪造成功。完整真机封装尚未通过验收，不自动修改配置、授权或启动服务。

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

# 仅在已有 rish/Shizuku 正常时；完整结果可能仍未确认，不会降级
pnpm phonectl --json exec --as shell -- /system/bin/id

pnpm --filter phonectl run check
pnpm --filter phonectl test
pnpm run pack:phonectl
# 从根运行时产物 phonectl-0.1.0.tgz；不执行发布
```

`pnpm phonectl` 直接运行构建产物，不改变当前工作目录，因此本地相对参数以调用目录解释。`node packages/phonectl/bin/phonectl.js ...` 等价。安装后的 `phonectl` 不需要 TS 加载器。

## 结果与错误契约

`--json` 应放在命令之前；stdout 只输出一份 `{ok,result}` 或 `{ok:false,error:{code,message,details?}}`。工具诊断放 stderr；命令自己的 stdout/stderr 在 JSON `result` 字段内。普通 exec 模式直接写回各输出流。输出按 UTF-8 文本解码，不提供二进制管道或交互 stdin/TTY。

`ok:true` 表示拿到了命令结果，**不表示命令退出码为 0**；CLI 退出码沿用命令 `exitCode`。工具错误退出 1，与结果内命令退出码区分。`exec` 必须显式使用 `--` 分隔参数，NUL 和空 executable 拒绝。

默认超时 30000ms，`--timeout <毫秒>` 可设为 1..3600000；超时 CLI 退出 124，`timedOut:true, completion:"unconfirmed"`。超时会终止本工具持有的直接子进程，但**不证明后代或 Android 远端进程已停止**，不会自动重试。shell 后端启动与结果传输最多另留 2 秒；没有身份/完整结果时返回工具错误，而不是伪造命令成功。命令正常返回 124/137 时 shell 后端也保守标为未确认，不能精确区分其主动返回和后端 timeout。

默认 stdout+stderr 上限 1 MiB，API 可调至最多 4 MiB。超出返回 `OUTPUT_LIMIT`，不承诺后代终止。shell 后端在 shell-owned `/data/local/tmp/phonectl.<随机>` 目录捕获输出（0700，文件0600），有限额/超时并尝试按所有权清理；后端进程崩溃或被系统杀死可能留下该目录，不自动扫描或广泛清理。它只存命令输出，不存 argv/凭据。

稳定工具错误：`INVALID_ARGUMENT`、`COMMAND_UNAVAILABLE`、`SHIZUKU_UNAVAILABLE`、`IDENTITY_MISMATCH`、`RESULT_UNCONFIRMED`、`OUTPUT_LIMIT`、`INTERNAL_ERROR`。shell 后端使用固定 POSIX quoting 将每个 argv 字面量编码到 rish 的 `-c` 接口；显式 shell 模式才解释用户脚本文本。这个封装不是对恶意 shell 权限进程的安全沙箱。

## AutoX 阻塞与未支持项

**本版未实现** `script run`、`task inspect`、`task logs` 或取消；也没有 push/pull、电脑端 SSH、守护进程、重启恢复或屏幕解锁。

已知 AutoX 7.2.3 的 `RunIntentActivity + file URI` 可启动脚本，RUN_COMMAND 可回收私有结果，但 Termux 私有目录是不同 UID 的 0700 目录，AutoX 无法直接读取这里的脚本。现有成功路径使用公共存储；当前未验证可授权的私有 content URI 交付路径。默认复制任意用户脚本到公共存储会暴露内容，且 hash 不能消除校验到执行之间的 TOCTOU 替换风险，因此本版停在可用本地核心，不提供看似成功的任务命令。

后续需先验证私有授权交付方式，或由用户明确接受**仅针对非敏感可信脚本**的显式共享暂存设计及残余风险，再补唯一 task/attempt、原子私有状态、认证结果回传、有界日志和异常/迟到/超时测试。Intent 受理不是脚本完成；不提供 stop-all 作为取消。

## AutoX 原生 Shizuku 替代方向

已静态核实本机 AutoX 7.2.3 的 Rhino 全局 `shizuku(cmd)`，返回 `result/error/code`。准确示例、官方与安装包出处、授权边界及 SSH/Intent 安全交付阻塞见 [AutoX Shizuku 后端方案](docs/autox-shizuku.md)。该方案未实现，示例本轮未在 AutoX 真机验收，不应与 rish 测试结果混淆。

该方案文档位于源码仓库；当前 npm `files` 白名单未包含 `docs/`，不会随现有打包配置发布。

GPL-2.0-only，见 LICENSE / NOTICE。
