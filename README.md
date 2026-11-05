# autox-bridge workspace

使用 pnpm 管理的 monorepo，现有 npm 包 **`autox-bridge@0.1.0`** 位于 [`packages/autox-bridge`](packages/autox-bridge)。包名、`autox` / `autox-bridge` 命令、ESM 导出及发布内容保持不变；完整安装、设备协议、CLI 用法和安全说明见 [包 README](packages/autox-bridge/README.md)。

## 目录结构

```text
.
├── package.json              # private，仅编排，不发布
├── pnpm-workspace.yaml       # 自动包含 packages/*
├── pnpm-lock.yaml            # 全仓库唯一锁文件
├── packages/
│   ├── autox-bridge/
│       ├── package.json      # 原 npm 包与生命周期脚本
│       ├── bin/              # JavaScript CLI 启动器
│       ├── src/              # TypeScript 源码
│       ├── dist/             # 构建产物，git 忽略
│       ├── test/             # 运行时与公开类型契约测试
│       ├── docs/             # 协议及用户级脚本文档
│       ├── tsconfig*.json
│       └── README.md / LICENSE / NOTICE
│   └── phonectl/              # 独立 Termux 本地 CLI，bin/src/test/配置/README
└── .agents/skills/autox-bridge/ # 仓库级 CLI 使用技能，不随 npm 包发布
```

另有独立的 Termux 本地控制核心包 [`phonectl`](packages/phonectl/README.md)。它不依赖 autox-bridge，不自带 SSH 客户端；目前支持只读状态、Termux argv 执行及不降级的 rish 适配。真机 rish 结果通道及 AutoX 安全交付存在明确限制，详见包 README。

## 从根目录开发

源码开发使用 **pnpm 11.5.3**（根 `packageManager` 固定），需要 **Node.js 22.13+**；发布包运行时要求仍为 **Node.js >=20**。使用已有对应 pnpm，勿混用 npm/yarn 或生成包内锁文件。

```sh
cd ~/gitrep/autox-bridge
pnpm install --frozen-lockfile
pnpm run check           # 所有 workspace 包的检查
pnpm run build           # 所有 workspace 包的构建
pnpm run test:types      # 公开类型契约检查，先构建
pnpm test                # 原有构建 + 类型契约 + 运行时测试

# 按包执行；filter 使用 package.json 中的 name
pnpm --filter autox-bridge run build
pnpm --filter autox-bridge test

# 不安装全局 CLI：先构建，再查看帮助/版本（不会连接设备）
pnpm cli --help
pnpm cli --version
# 授权并确认端口空闲后才启动服务
pnpm start --host 0.0.0.0
```

`pnpm start` 仍会先构建。`pnpm cli` 是开发入口，不自动构建，参数按包目录解释；传入脚本/项目路径时建议使用绝对路径。也可从根运行 `node packages/autox-bridge/bin/autox-bridge.js --help`。

### 打包，不发布

```sh
pnpm run pack:bridge
# 等价于 pnpm --filter autox-bridge pack
# 从根运行的产物：autox-bridge-0.1.0.tgz
```

包级 `prepack` 保持原有检查、构建及测试；tarball 内仍以 `package/bin`、`package/dist`、`package/src`、`package/docs` 等为根，不包含 monorepo 的 `packages/` 前缀。根包为 private，不作为发布目标。包版本变化时以实际生成文件名为准。本任务不执行全局安装或 npm 发布。

迁移保留原 `pnpm-lock.yaml`，仅将原根 importer 移到 `packages/autox-bridge` 并加入空的根 importer；没有更换锁文件格式或升级业务依赖。仓库当前没有 CI 配置；如新增 CI，应从根运行上述 frozen install、检查、构建和测试命令。

### Termux 本地 phonectl

```sh
pnpm run build
pnpm phonectl --help
pnpm phonectl --json status
pnpm phonectl --json exec --as termux -- pwd
pnpm --filter phonectl test
pnpm run pack:phonectl   # 根目录产物 phonectl-0.1.0.tgz
# 两个包均已打包后，可审计解包入口、bin、声明及发布清单
pnpm run audit:packs
```

`phonectl` 当前是核心切片；AutoX script/task 命令未实现，不会静默把用户脚本放到公共存储。

## 后续新增 npm 包

1. 新建 `packages/<目录名>/package.json`，设置唯一 `name`、`version`、入口/发布文件和自己的 `build`、`check`、`test` 等脚本；不发布的包设置 `private: true`。
2. 在该目录放置源码、测试和必要配置；`packages/*` 会自动发现，无需修改根脚本。
3. 从根运行 `pnpm install` 更新同一份锁文件。包间依赖使用 `workspace:*`，例如 `pnpm --filter <新包名> add autox-bridge@workspace:*`。
4. 运行根 `pnpm run check`、`pnpm run build`、`pnpm test`；单包使用 `pnpm --filter <包名> <命令>`，打包使用 `pnpm --filter <包名> pack`。

GPL-2.0-only。来源与归属见 [NOTICE](NOTICE)。
