# AutoX 7.2.3 Web API 可行性研究（历史静态结论，后续已实现Node后端）

**后续更新：**用户已授权开发与回环真实验证。已在AutoX独立`.mjs`内嵌Node v24.11.1实现`node:http`服务、Node Java桥接直接Shizuku执行及私有key配对；当前使用和验证边界见 [AutoX HTTP后端](autox-http.md)。下文保留的是开发前静态研究，不应作为“AutoX仅支持Rhino/没有Node”的结论。

## 结论

**本段为开发前结论，后续Node HTTP实现已取得真机证据，见上方更新。** 推荐下一步做独立、手动启动且限时的 **127.0.0.1 + SSH 隧道** 原型，而不是暴露 LAN 或替换现有后端。本轮没有绑定任何地址/端口，没有生成 API key，没有安装依赖、自启动或权限变更。

当前 Rhino `.js` 能调用 Java/Android API（本机诊断脚本已实际使用 Java Thread、File、Scanner 等），可候选使用平台 `java.net.ServerSocket` 接受 TCP 后实现严格受限的 HTTP/1.1 子集。但**能访问 Java 不等于 HTTP 服务已经可用**；仍需验证 bind/accept、读写期限、线程/引擎生命周期。手写 HTTP 解析有明显风险，生产实现应优先复用经过确认的 server 库。此时研究遗漏了AutoX独立Node模式；后续APK内`nodejs/intro`、`NodeScriptEngine`和`NodeModuleResolver`已确认`.mjs`可加载`node:http`，因此最终实现采用Node而非手写Java HTTP。

## 版本和来源

安装 APK：`org.autojs.autoxjs.v7`，7.2.3/code723。静态读取下列实际 APK 资源：

- `assets/docs/v2/docs/rhino/base/http/index.html` 与 `assets/v6modules/http/index.js`：`http.get/post/request` 是 **客户端**，不是 server。
- `assets/docs/v2/docs/rhino/base/websocket/index.html`：示例使用 OkHttp 客户端；末尾泛称可创建服务器，但未提供实际 server API，**不能把这个句子或 OkHttpClient 当成服务端证据**。
- `assets/docs/v2/docs/rhino/advanced/threads/index.html`：`threads.start`、线程中断和生命周期；文档警告 JavaScript 多线程安全。脚本启动的线程可使生命周期延长，强制停止关联线程不等于打断所有 Binder 调用。
- APK dex 引用包含 `Ljava/net/ServerSocket;`；针对 NanoHTTPD、Java-WebSocket server、AsyncHttpServer 的特定常见描述符未匹配。该有限检查不是证明所有 server 库绝对不存在。

固定官方版本参考（版本文件为7.2.3/723，不声称APK逐字由它构建）：

- [RhinoJavaScriptEngine.kt](https://github.com/autox-community/AutoX_aiselp/blob/f10667060f63f1d5069eb60635faefe3023ae07c/autojs/src/main/java/com/stardust/autojs/engine/RhinoJavaScriptEngine.kt)：Java桥接包装、Rhino scope、CommonJS asset模块；forceStop主要中断引擎线程。**Rhino require 不等于 Node require('node:http')**。
- [LoopBasedJavaScriptEngine.java](https://github.com/autox-community/AutoX_aiselp/blob/f10667060f63f1d5069eb60635faefe3023ae07c/autojs/src/main/java/com/stardust/autojs/engine/LoopBasedJavaScriptEngine.java)：Looper与destroy清理。
- [ScriptRuntime.java](https://github.com/autox-community/AutoX_aiselp/blob/f10667060f63f1d5069eb60635faefe3023ae07c/autojs/src/main/java/com/stardust/autojs/runtime/ScriptRuntime.java)：exit事件、线程/timer等回收。
- [autojs/build.gradle.kts](https://github.com/autox-community/AutoX_aiselp/blob/f10667060f63f1d5069eb60635faefe3023ae07c/autojs/build.gradle.kts)：Rhino、OkHttp、ktsh、Shizuku依赖；存在独立Node实现不代表当前Rhino脚本可用Node HTTP模块。
- [Shizuku.kt](https://github.com/autox-community/AutoX_aiselp/blob/f10667060f63f1d5069eb60635faefe3023ae07c/autojs/src/main/java/com/stardust/autojs/runtime/api/Shizuku.kt)：同步runBlocking服务调用。

本机静态摘录保存在忽略目录 `.planning/autox-web-feasibility/`，没有执行其中脚本。

## 最小候选结构

- 一个手动启动脚本，一个accept线程，严格限制连接数、请求行/headers/body大小及读超时；初版仅POST固定JSON、Content-Length，拒绝chunked/重复歧义长度/未知路径/非JSON/管道复用。这不是完整通用HTTP服务器。
- 控制线程与**单个Shizuku执行worker**分离；有界队列，不允许无限线程或并发shell。health必须在worker阻塞时仍能响应，busy时返回409/429。
- 每个Java线程的Rhino context/闭包访问、共享队列、异常边界需要原型验证；不能在UI线程运行阻塞accept/Shizuku。
- 手动停止先停止接收、关闭ServerSocket和所有连接、拒绝新请求并清理资源；socket.close用于唤醒accept，不能只依赖Thread.interrupt。停止API不等于取消Android命令，不能提供stop-all。
- 不添加启动任务、watcher或后台服务。Android后台存活、锁屏、电池限制、引擎退出可能中止脚本，均不能承诺无人值守常驻。
- 本次实际旧runner曾卡在BinderProxy.runShellCommand，forceStop请求未立即销毁engine；Web层不会自动修复这个事实，必须隔离未知执行，不继续排队重复命令。

## 候选接口草图（未实现）

所有接口包括health都要求Authorization；禁止任意callback路径/URL、代码eval及AutoX JS上传。

| 接口 | 语义 |
|---|---|
| `GET /v1/health` | 版本、服务instanceId、worker busy/unknown；不得返回key、完整环境或命令日志 |
| `POST /v1/executions` | version、requestId/attempt、deadline、argv或显式shell、输出限额；202只表示接收，不表示完成 |
| `GET /v1/executions/<requestId>?attempt=...` | queued/running/completed/unknown/expired；结果含stdout/stderr/code及command/userCommand/executedCommand |
| `POST /v1/control/stop`（可选） | 仅停止该原型监听，不停止其他脚本或伪称取消shell；也可只保留本地手动停止 |

requestId/attempt绑定、重复输入一致性检查、单飞、有界TTL结果表。仅对相同ID/相同内容返回已有状态；不能因客户端重试自动再执行。等待deadline到达只标unknown，不伪造退出码。结果真实采用Shizuku r.code；限制文本输出，不称字节保真。结果保留实际调用变量并由phonectl与私有预期比较，防意外串任务，不证明OS二进制身份。

## API key与传输边界

- 使用至少32随机字节（例如AutoX Java SecureRandom），不可用时间戳/UUID充当key。采用 `Authorization: Bearer <key>`，不放URL/query、公共runner、sdcard请求、屏幕Toast或日志。
- key在AutoX自身 `context.getFilesDir()` 私有目录保存，首次生成与读取/客户端安全配对路径需单独设计；Termux不能直接读取AutoX私有文件。**没有已证实的无UI私有配对路径，不能靠把key落sdcard偷偷解决**。
- 可以研究Android Keystore或私有SharedPreferences，但“私有”不意味着加密或可抵御恶意同UID代码。若公共runner被替换，它以AutoX身份运行，可能读取key：上线鉴权服务前应把服务器源码部署到AutoX私有目录并确认bootstrap完整性，不能沿用公共runner仍声称强安全。
- key只保留内存/私有文件；比较应使用固定长度、尽量常量时间；拒绝空key/多重Authorization，限制失败频率。key丢失不自动降为无鉴权。
- 轮换由用户手动操作，先安全分发新key，短期限双key重叠或原子切换，撤销旧key；日志仅key版本/错误码，不记录原值。结果TTL清理不扩成持久调度系统。
- **明文LAN HTTP会暴露Bearer key和命令/输出**，不推荐。仅127.0.0.1监听+现有SSH认证隧道避免无线明文，但loopback仍可能被其他本机应用访问，必须鉴权、body限额及速率控制；不允许Origin/Host歧义或浏览器跨域访问。
- LAN方案需TLS和证书校验/固定可信反向代理、防火墙和访问控制，并处理TLS终止到设备段保护；这是额外部署范围，当前不授权。API key不是加密，不是多用户权限隔离；持key者可获得shell2000执行能力。

## 推荐的下一次原型验收（先确认再启动）

拟议 **127.0.0.1:18765，最长120秒**，仅一个手动AutoX诊断脚本，finally关闭监听/连接，退出后确认端口释放；端口冲突则停止，不自动换到0.0.0.0。不安装依赖，不设置自启动，不改防火墙。**这是原静态计划；之后用户已授权实施，最终采用系统分配回环端口，具体行为见实施文档，不按此固定端口部署。**

1. 静态核实ServerSocket可用构造方法、实际classloader、线程context；无Shizuku命令先验收health、缺/错key拒绝、畸形长度/超限/慢连接。
2. 明确私有key bootstrap与客户端配对，确认公共源码不含key且不能替换生产入口；鉴权前不执行任何命令。
3. 仅固定id、固定两路打印、exit7验证身份/真实code/实际命令字符串及并发busy；不操作其他应用/系统配置。
4. 验收限时停止、连接清理、监听释放、worker阻塞时health及unknown语义；不声称能够取消不可中断Binder。
5. 验证SSH隧道后再讨论是否值得替代文件请求，不默认迁移当前后端。

## 已证实 / 未验证

已证实：Rhino Java桥接、线程API文档、HTTP/WS示例主要为客户端、同步Shizuku实际执行及Binder阻塞风险。静态证据支持平台Java server路径，无需假定Node。

未验证：当前引擎真正bind/accept与HTTP读写、Java线程上的Rhino回调、稳定生命周期、HTTP实现鲁棒性、私有key配对、TLS、后台存活。没有真实Web监听、API key或可运行Web后端交付。
