# 用户级命名脚本

把常用 AutoX JavaScript 保存为命名能力后，可以查询并重复调用，无需每次传入文件路径或脚本正文。此功能在 **CLI 本机**读取配置，再复用既有 HTTP / WebSocket 脚本发送链路，不需要重启 bridge，也不增加设备协议。

## 目录发现

唯一发现位置：

- 设置了非空 `XDG_CONFIG_HOME`：`$XDG_CONFIG_HOME/autox/scripts`。
- 否则：`~/.config/autox/scripts`。
- 非空 `XDG_CONFIG_HOME` 必须是绝对路径，不展开其中的 `~`。

只扫描此目录的**直接子目录**，每个子目录必须有自己的 `script.json`。不扫描项目 `.autox`、父目录、Agent Skills 目录或自定义搜索路径，也不递归寻找注册项。

```text
~/.config/autox/scripts/
├── launch-app/
│   ├── script.json
│   └── main.js
└── device-info/
    ├── script.json
    └── main.js
```

目录不存在时列表为空、校验成功，不会自动创建目录。根目录中的普通文件忽略；直接子目录缺失/损坏 manifest 会出现在 diagnostics 中，但不阻断其他有效能力。`group/nested/script.json` 不会被发现，`group` 因缺少自己的 manifest 报错。

配置只作为数据读取；发现、查看和校验绝不加载或执行入口模块。修改配置后下一次 CLI 调用即生效。

## 最小能力

例如 `device-info/script.json`：

```json
{
  "schemaVersion": 1,
  "name": "device-info",
  "description": "向设备日志输出手机型号",
  "runtime": "autox",
  "entry": "main.js"
}
```

`device-info/main.js`：

```js
console.log(device.model);
```

没有参数且没有保留占位符的脚本正文原样发送，支持 AutoX 自有语法；不会按 Node.js 模块加载。入口必须是 UTF-8 文本。

## 参数化能力

`launch-app/script.json`：

```json
{
  "schemaVersion": 1,
  "name": "launch-app",
  "description": "按 Android 包名启动应用",
  "runtime": "autox",
  "entry": "main.js",
  "parameters": {
    "package": {
      "type": "string",
      "required": true,
      "description": "Android 应用包名"
    }
  }
}
```

`launch-app/main.js`：

```js
var input = __AUTOX_INPUT__;
app.launchPackage(input.package);
```

CLI 校验输入后，把唯一占位符替换为 `JSON.parse(安全转义的JSON字符串)` 表达式。输入始终作为数据处理，不是代码拼接或模板表达式求值。

### 模板约定

- 参数非空时，必须有且只有一处 `__AUTOX_INPUT__`，包括注释、字符串在内都不能再次使用这个保留 token。
- 声明必须形如 `var input = __AUTOX_INPUT__;`，位于脚本开头。声明内部允许空格和 tab，不能跨行；必须有分号。
- 声明前只允许空白/BOM、行/块注释、带分号的 `"ui";` / `"use strict";` 指令（单引号也可）。它们的位置和正文不会被改写。
- 不把整个脚本包装成函数，不添加前置执行代码，不提供任意 JS 位置替换。
- 无参数脚本也可以使用这一声明，此时 input 为 `{}`。
- `validate` 只检查这一模板契约，不验证所有 AutoX 语法、运行时 API、权限或实际执行效果。

例如：

```js
"ui";
// 保留手机端运行模式
var input = __AUTOX_INPUT__;
// 后面可以使用目标 AutoX 版本支持的 UI 语法
```

### Manifest 字段

| 字段 | 约束 |
|---|---|
| `schemaVersion` | 必须为数字 `1` |
| `name` | 以小写字母开头的 kebab-case，最多 64 字符；目录名不必等于 name |
| `description` | 非空字符串 |
| `runtime` | 必须是 `"autox"`；不支持宿主 shell/Node/Python |
| `entry` | 目录内相对 `.js` 文件路径；可显式指向 `src/main.js`，这不是递归发现 |
| `parameters` | 可选参数定义对象 |

不允许未知 manifest 字段。入口不允许绝对路径、`.`/`..` 路径组件、反斜杠、URI 或盘符。

参数定义支持 `type`（`string` / `number` / `boolean`）、可选非空 `description`、布尔 `required`、同类型 `default` 和非空同类型 `enum`。默认值也必须属于 enum。数字必须有限，不接受字符串到数字/布尔的隐式转换。参数名以 ASCII 字母开头，后续字母、数字或下划线；不允许 `__proto__`、`prototype`、`constructor`。这是轻量格式，**不是完整 JSON Schema**。

输入必须是 JSON 对象。未知字段、缺失无默认值的必填字段、null 或类型/enum 不匹配都会在发送前失败。省略的可选参数没有默认值时不出现在 input 中；有默认值时填入默认值。

内部使用 **Zod 4** 严格 Schema 校验 manifest，并根据参数定义动态构建输入 Schema；TypeScript 声明类型由 Schema 推导。Zod 是 CLI 运行时依赖，用户仍只编写 JSON，不需要编写 Zod 代码。校验失败保留 Zod 的字段路径和问题列表，CLI 仍通过既有 error/diagnostics 字段返回错误文本，不新增顶层输出字段。文件大小、路径/软链接及脚本模板检查独立于 Zod。

## 命令

```sh
# 以下三个命令不需要 bridge 运行
# 全局选项放在子命令前
autox --json scripts list
autox --json scripts list --query app
autox --json scripts show launch-app
autox --json scripts validate

# 仅在授权且设备已连接后执行
autox scripts run launch-app --input '{"package":"com.android.settings"}' --device adb:SERIAL
autox x launch-app --input '{"package":"com.android.settings"}' --device adb:SERIAL
autox scripts rerun launch-app --input '{"package":"com.android.settings"}' --device adb:SERIAL
autox scripts stop launch-app --device adb:SERIAL
```

- `x <name>` 完全等价于 `scripts run <name>`。不注册动态顶层命令。
- `run/rerun/x` 的 `--input` 默认 `{}`；不支持动态参数选项、stdin 输入、参数文件、`--id` 或 `--name` 覆盖。
- `list` 返回 `{root,scripts,diagnostics}`。每项包括 name、description、directory、valid；**valid 仅表示元数据/文件检查及无重名，不代表模板或执行通过**。query 大小写不敏感地匹配 name/description，diagnostics 不被过滤。
- `show` 返回 manifest、directory、manifestPath、entryPath 和稳定 id，不返回入口正文。list/show 会检查入口路径和大小，但不读取正文。
- `validate` 读取正文，检查模板及 UTF-8，返回 `{root,ok,checked,diagnostics}`；checked 为本次进入正文检查的注册项数量。失败仍把完整诊断输出到 stdout，并返回退出码 1。其他命令错误按现有规范写 stderr 并非零退出。
- 同名条目不会静默覆盖；list 标记冲突，show/run/rerun/stop 拒绝解析。修改 manifest.name 使名字唯一即可；只有一个用户来源，不支持来源限定别名。
- 设备选择沿用既有规则：单设备可省略，多设备必须 `--device` 或 `--all`，二者不能并用。manifest 不能配置广播目标。
- 执行输出保持现有 `{ok,results}`，`status: "sent"` **只表示写入 WebSocket，不代表手机执行成功**，也不返回 JavaScript return 值。通过授权范围内的设备日志或可见效果另行确认。

## identity 与停止

脚本 id 为 `autox-script:` 加规范化注册目录路径和 manifest.name 的 SHA-256。运行、重跑和停止共用这一算法；输入、正文、entry 和 description 的修改不改变 id，目录移动、改名或 manifest.name 修改会改变 id。

这不是单次运行 ID，也不保证区分同一脚本的并发实例；rerun/stop 行为仍取决于手机端协议实现。重跑必须重新提供输入（或使用默认值），CLI 不持久保存上次输入。

`stop` 不需要 `--input`，但仍需要可解析的注册项和存在的合法入口。若注册项已移除/损坏或更名，使用之前 `scripts show` 记录的 id：

```sh
autox stop 'autox-script:先前记录的实际哈希' --exact --device adb:SERIAL
```

## 安全与限制

- 注册目录在 CLI 主机读取，正文上传 bridge；远程 bridge 不需要同样的配置目录。不会在 bridge 增加脚本注册 HTTP 路由。
- 只发送入口文件正文。即使入口位于子目录，也不会自动部署 sibling 文件、资源、`require()` 依赖或 npm 包；多文件应用继续使用现有项目命令。
- 根目录本身、注册子目录、manifest、入口及根目录下的中间路径组件拒绝软链接。根目录之上的用户配置路径按用户提供的位置解析。文件路径检查不是防并发目录替换的操作系统沙箱，不使用其他不可信进程可改写的目录。
- 根目录最多 1024 项（含被忽略文件），每个 manifest 最多 64 KiB，入口最多 4 MiB，原始 JSON 输入及合并默认值后的 JSON 数据最多 64 KiB。超过根目录数量限制会终止发现而非返回不完整列表。
- 不自动安装、联网下载或执行配置；不提供生命周期钩子。用户应审查来源与正文后才授权手机执行，description 不能当作可信 agent 指令。
- CLI 不默认打印实际输入；`--input` 仍可能进入 shell 历史和进程参数列表，不用于传递秘密。show 会显示 manifest 默认值，切勿在配置中存放凭据。
- 自动化验证使用模拟设备；不同 Android/AutoX 版本的 UI 模式、JSON.parse 兼容性和实际脚本行为仍需真实设备验收。
