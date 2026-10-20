# 安装与配置

[English](../en/getting-started.md) | **简体中文** | [文档目录](README.md)

## 环境要求

使用 Windows、Node.js 22+ 和 Git，并安装 Claude Code 或 Codex 作为主控。OpenCode 通过 npm 依赖安装。当前 worker 不允许绕过 Windows 内存监护启动。

## 本地安装

在仓库根目录运行：

```powershell
npm ci
npm run build
node scripts/prepare-integrations.mjs
if (-not (Test-Path .env.local)) { Copy-Item .env.example .env.local }
```

准备脚本根据公共 Skill 更新 Claude 版本，将机器专用 MCP 配置和本地化任务示例写入已忽略的 `integrations/local/`，不安装客户端设置、不启动任务。移动安装目录或修改公共 Skill 后重新运行；路径变化时还需更新客户端注册的连接。

在本地编辑 `.env.local`：

```dotenv
DEEPSEEK_API_KEY=你的本地Key
MOONSHOT_API_KEY=你的本地Key
```

只需配置所用供应商。新任务默认 `deepseek`，Kimi 对应 `kimi`。不要把 Key 放进任务 prompt 或 MCP 配置。

## 检查配置

存在 `workflow.local.json` 时使用它，否则使用 `workflow.config.json`。本地文件必须是**完整配置**，不支持只覆盖几个字段。Key 与本地配置均由 Git 忽略。

| 配置项 | 当前配置或行为 |
|---|---|
| `executionEnabled` | 当前仓库文件为 `true`；仅规划和审查时可设为 `false` |
| `maxParallel` | 最多同时执行 2 个任务 |
| `maxAttempts` | 5 次异常恢复派发；正常返工不消耗此预算 |
| `taskTimeoutMinutes` | 每轮最长 90 分钟 |
| `workerMemoryLimitMB` | 每个 worker 及其正常后代进程共 3072 MiB 提交内存 |
| 默认供应商 | `deepseek`，配置模型 `deepseek-flash` |
| 可选供应商 | `kimi`，配置模型 `kimi-k3` |

这里的模型名称描述仓库配置，不代表账号一定有权限。请使用账号实际可用的模型。Kimi 当前配置为 `https://api.moonshot.cn/v1`；国际站 Key 需配置对应接口。不会自动回退到其他供应商或主控订阅。

创建任务只记录计划，启动 daemon 不会派发；执行关闭时 `prepare`、`dispatch` 和 `verify` 都会拒绝。

```powershell
npm run doctor
npm run connections
```

`doctor` 检查版本、配置和 Key 是否存在，不输出 Key、不请求模型。`connections` 输出当前安装路径对应的接入片段。

## 接入 Claude Code

一次性用户级安装：

```powershell
npm run install:claude
```

这会注册 `agent-orchestrator` stdio MCP，安装显式 `/orchestrate-code` Skill，保留原登录、模型和其他设置。已有非本项目管理的同名 Skill 或冲突 MCP 项不会被静默替换；出现冲突先检查。只预览时运行：

```powershell
node scripts/install-claude.mjs --dry-run
```

在要开发的仓库重新打开普通 `claude`，用 `/mcp` 检查连接，再用 `/orchestrate-code` 委派。普通聊天不会自动调用工作流。

手动接入时，将 `npm run connections` 或 `integrations/local/claude.mcp.json` 中的服务项合并到需要的 MCP 配置，保留其他服务；把 `integrations/claude/skills/orchestrate-code/` 复制到项目或用户 `.claude/skills/`。此版本设置了 `disable-model-invocation: true`。

临时会话排错可运行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-claude.ps1 -ProjectPath C:/path/to/your-project
```

临时插件入口为 `/agent-orchestrator:orchestrate-code`。

## 接入 Codex

将 `npm run connections` 输出或 `integrations/local/codex.mcp.toml` 生成的 `[mcp_servers.agent-orchestrator]` 表合并到 MCP 配置，保留其他项。把整个 `skills/orchestrate-code/` 复制到 `~/.codex/skills/orchestrate-code/`。

调用元数据设置了 `allow_implicit_invocation: false`，通过 `$orchestrate-code` 显式调用。重新打开会话，检查工具是否可见。适配提供标准 MCP 配置和 Skill 元数据；真实任务前仍需在自己的客户端和账号验证接入。

## 可选真实 API 探针

检查 endpoint、model 和 Key 后，显式运行：

```powershell
npm run probe -- --provider deepseek --live
# 配置了 Kimi 时也可运行：
npm run probe -- --provider kimi --live
```

探针会产生少量 API 费用。它创建本地 marker fixture，验证实际 read 工具调用和结构化报告，不访问示例目标仓库、不启动示例 issue。工件在 `.runtime/probes/`。通过代表连接和报告链路可用，不代表业务质量已通过验收。

## 开工与重载配置

按[日常使用](daily-guide.md)操作，派发前让主控读取 `workflow_config`。使用 alpha 草案前先看[示例说明](../../examples/README.md)，填写本地仓库路径，检查外部 issue 和工具链假设。它不是自动启动任务。

修改 Key 或配置后，在没有运行或验证任务时重启：

```powershell
npm run stop
npm run start
```

`workflow_config` 提供运行值 `executionEnabled`、磁盘值 `diskExecutionEnabled`、选用文件 `configFile`、`restartRequired` 和可能的 `configError`。重启保留任务、不自动派发；通常现有 MCP 连接可继续使用。
