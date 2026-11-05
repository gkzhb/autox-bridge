# AutoX.js 7.2.3 的 Shizuku 后端方案（未实现、未完成真机验收）

## 结论与版本证据

本机包 `org.autojs.autoxjs.v7` 的 APK 二进制 manifest 静态解析得到 `versionName=7.2.3`、`versionCode=723`。实际 API 是 **Rhino 全局 `shizuku(cmd)`**，不是 `shell.shizuku()`，也不是普通 `shell(cmd)` 自动升级权限。

安装 APK 内的以下文件是本机版本直接证据：

- `assets/v6modules/shizuku/index.js`：`shizuku(cmd)` 调用 `runtime.shizuku.runShizukuShellCommand(cmd)`；`shizuku.isAlive()` 调用 `isShizukuAlive()`。
- `assets/v6modules/init.js`：`utils.setGlobal('shizuku', shizuku_index)` 注册全局函数。
- `assets/docs/v2/docs/rhino/advanced/shizuku/index.html`：说明模块自 v7.1.1 新增，不可用时抛错，返回 `ShellResult`。
- `assets/docs/v2/docs/rhino/advanced/shell/index.html`：`ShellResult` 的 `result` 是 stdout，`error` 是 stderr，`code` 是返回码。

官方维护仓库的版本对应源码（固定提交，避免依赖移动分支）：

1. [AutoX_aiselp project-versions.json](https://github.com/autox-community/AutoX_aiselp/blob/f10667060f63f1d5069eb60635faefe3023ae07c/project-versions.json)：app/dev 版本均为 7.2.3 / 723。此提交作为源码参考，不声称安装 APK 与其逐字构建一致。
2. [shizuku/index.ts](https://github.com/autox-community/AutoX_aiselp/blob/f10667060f63f1d5069eb60635faefe3023ae07c/autojs/src/main/js/v6-api/src/shizuku/index.ts)：JS 接口。
3. [runtime/api/Shizuku.kt](https://github.com/autox-community/AutoX_aiselp/blob/f10667060f63f1d5069eb60635faefe3023ae07c/autojs/src/main/java/com/stardust/autojs/runtime/api/Shizuku.kt)：经 `ensureShizukuService()`、`runShellCommand(id, cmd)` 返回 `AbstractShell.Result`。
4. [AbstractShell.java](https://github.com/autox-community/AutoX_aiselp/blob/f10667060f63f1d5069eb60635faefe3023ae07c/autojs/src/main/java/com/stardust/autojs/runtime/api/AbstractShell.java)：公开字段 `int code`、`String error`、`String result`。
5. [Shell2.kt](https://github.com/autox-community/AutoX_aiselp/blob/f10667060f63f1d5069eb60635faefe3023ae07c/autojs/src/main/java/com/stardust/autojs/core/util/Shell2.kt)：shell 执行结果按 `exitCode/stdout()/stderr()` 映射；不要由此推导本设备必然无丢失或精确保留尾部换行。
6. 官方文档：[shizuku](https://github.com/autox-community/AutoX_aiselp_Docs/blob/49ea8c664e972337efa1975f1f0051769bb4e740/docs/rhino/advanced/shizuku.md)、[ShellResult](https://github.com/autox-community/AutoX_aiselp_Docs/blob/49ea8c664e972337efa1975f1f0051769bb4e740/docs/rhino/advanced/shell.md#shellresult)。

安装 APK 中 Shizuku 模块 SHA256：`99f7d0d07a9955e19418594c0c51e10a71b0e0d9a4547050cf97d98cd05cb75b`。本轮取证副本及 manifest/资源哈希在本地忽略目录 `.planning/rish-merge-autox/`；它们不是随 npm 包发布的材料。源码/API 已静态核实，**下面脚本本轮没有在 AutoX 真机运行**。

## 授权和身份边界

- 需要 Shizuku 已激活，并且 **AutoX** 已单独授权；Termux rish 获权不等于 AutoX 获权。
- `shizuku.isAlive()` 是可用性提示，不替代命令执行和 UID 校验；当前参考实现检查已连接的 Shizuku user service。false 时应停止，不自动申请权限、启动服务或调用 `openAccessibility()`。
- Shizuku ADB 模式预期执行身份为 Android shell UID 2000；root/Sui 模式不能未经确认套用这个预期。必须用实际命令确认，不把 AutoX 应用自身 UID 当作 shell UID。
- 以下为 Rhino `.js` 脚本，不是 Node `.mjs`；参数是 shell 文本，不是安全 argv 接口。只使用固定可信文本，不拼接不可信输入。

## 最小身份示例

只在已经授权的 AutoX 环境中运行；不负责申请权限或交付脚本：

```js
if (typeof shizuku !== 'function' || !shizuku.isAlive()) {
    throw new Error('AutoX Shizuku backend is not connected; stop without requesting permission');
}
var r = shizuku('id -u');
var uidText = String(r.result).trim();
if (Number(r.code) !== 0 || uidText !== '2000') {
    throw new Error('Expected Android shell uid=2000; result not accepted');
}
console.log(JSON.stringify({
    backend: 'autox-shizuku',
    uid: 2000,
    stdout: String(r.result),
    stderr: String(r.error),
    code: Number(r.code)
}));
```

上述身份仅确认该次 `id`；正式后端必须将身份校验和实际执行放在同次受控执行里，避免把此前的成功探针当作后续执行证明。

### 后续验收用固定输出示例（未执行）

身份示例通过后，另行验收返回通道；显式子 shell 防止 `exit 7` 退出可复用的外层 shell：

```js
var r = shizuku("/system/bin/sh -c 'printf \"AUTOX_STDOUT\\n\"; printf \"AUTOX_STDERR\\n\" >&2; exit 7'");
console.log(JSON.stringify({
    stdout: String(r.result),
    stderr: String(r.error),
    code: Number(r.code)
}));
```

API 契约预期 stdout 包含 `AUTOX_STDOUT`、stderr 包含 `AUTOX_STDERR`、code 为 7；**这不是本轮实测结果**。换行保留、并发隔离、超时、取消、Shizuku 断连、shell 实例退出后的复用行为都需要额外验收。不要将 rish 的通过/失败替代为此 API 的通过/失败。

## 更优方向：phonectl → AutoX → Shizuku

此方向绕过 Termux rish 的 app_process 管道传输，使用 AutoX 已提供的 Shizuku user-service 调用及结构化 `ShellResult`。它是候选后端，不是已证明更可靠的成品，也不是把两路合并就能获得完整 stderr 的承诺。

建议链路（本轮未实现）：

1. 上位机经现有 SSH 调用 Termux phonectl，生成随机 request/attempt ID 和私有状态，不增设网络服务。
2. 用已验证的 Termux `$PREFIX/bin/am` + `RunIntentActivity` 入口启动受控 AutoX `.js`。Intent 受理仅表示启动请求，不表示完成。
3. AutoX 校验请求后调用 `shizuku()`；保留 stdout/stderr/code，校验执行身份，回传有界、结构化结果；不自动回退 Termux 或 root。
4. AutoX 经已有 Termux `RUN_COMMAND` 路径提交**固定入口及数据参数**，由 Termux 写入本次请求私有结果，再由 SSH 取回。不要将任意结果文本拼接成 shell 命令，也不要直接相信公共目录中的结果文件。

### 当前阻塞：安全交付和结果认证

- `RunIntentActivity + file URI` 的历史成功路径使用共享存储。Termux 私有目录属于不同 UID，AutoX 不能直接读取。尚无经过验证的私有 content URI 授权交付，不能默认把用户脚本复制到公共存储。
- 已有私有结果回收历史样例，不等于生产级认证回调；正式实现需要请求/attempt 绑定、不可猜回调凭据、数据限额和校验、防重复/迟到、原子私有写入。随机 ID 本身不等于认证。
- 不允许通过放宽文件权限、改 AutoX/Shizuku 授权、自动弹窗确认、stop-all 或新网络监听绕过阻塞。
- 在安全交付与回传方案获准并验证前，本轮只提供接口与示例，**不运行新增公共暂存 AutoX 脚本、不实现完整任务系统**。

## 与当前 rish 最小修复的关系

当前改动仅把 rish 子进程两条 pipe 的 Buffer 按 **Node data 事件抵达顺序**拼入同一传输缓冲，用于原有身份 marker 和结果帧解析。结果帧中的命令 stdout/stderr 仍分别返回；Termux 后端仍分别捕获。

这不是恢复子进程原始全局写入顺序的协议：跨 pipe 重排、重复或字节缺失仍可能使 marker/结果不完整，并明确失败。两路都没有收到的 stderr 无法靠合并恢复。本轮没有新增退出码修复，也未改变原有 code framing；缺帧不会以外层 0 伪造成功。
