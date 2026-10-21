# 本地 Agent 工作流

[English](README.md) | **简体中文**

通过本地 MCP，让 Claude Code 或 Codex 主控把编码工作委派给 OpenCode worker，再独立审查和验证结果。主控继续使用原来的模型与订阅，worker 使用单独配置的模型 API。

项目仍在开发中。当前 worker 执行需要 **Windows**，通过 Job Object 实施每个 worker 的内存上限。

## 功能

- 使用带版本的任务契约，明确范围、设计决定、验收标准与证据。
- 按仓库保存项目偏好，自动生成完整合同和配置快照，并明确选择验证策略。
- 支持独立 Git worktree、原目录新建分支或使用当前分支。
- 持久化任务与会话，支持审查、返工和中断恢复。
- worker 运行增量检查，主控独立选择并执行验收验证。
- 新任务默认使用 DeepSeek，也可显式选择 Kimi。
- 默认将每个 worker 及其正常创建的编译、测试后代进程限制为 3 GiB 提交内存。

```text
Claude Code / Codex 主控
  -> 显式调用的 Skill + MCP 桥接
    -> 本地调度 daemon
      -> OpenCode worker -> 配置的模型 API
    <- 结构化报告 -> 独立审查与验证
```

## 快速开始

安装 Node.js 22+、Git 和主控客户端，在仓库根目录运行：

```powershell
.\setup.ps1
```

向导选择 Claude Code、Codex 或两者，安装后端依赖（包含 OpenCode）、编译，通过隐藏输入配置所选供应商的 API Key，安装用户级 Skill 并注册 MCP。最后检查 Windows 内存监护和 MCP 握手，不请求模型。Node 仅检查、不安装。项目示例和 repository profile 独立处理。也可运行 `npm run setup`。

带参数安装或预览：

```powershell
npm run setup -- --client codex --provider deepseek --non-interactive
npm run setup -- --client both --dry-run
```

非交互安装需要事先在 `.env.local` 或环境变量中提供所选 Key。派发前检查有效配置的 `executionEnabled`，当前仓库文件为 `true`。安装不调用模型、不派发任务。

安装完成后，在要开发的仓库重新打开 Claude，然后输入：

```text
/orchestrate-code 从 <基线> 实现 <目标>。把实现交给 DeepSeek，你审查 diff 并独立验证结果。不要 commit 或 push。
```

Codex 用户通过 `$orchestrate-code` 显式调用。手动安装、修复、冲突处理和可选真实验证见[安装与配置](docs/zh-CN/getting-started.md)。

本地源码变化或收到新版本后，双击 `update.cmd` 或运行 `npm run update`。`npm run update -- --check` 检查已安装指令，显式加 `--pull` 才拉取远端并快进，详见[更新工作流](docs/zh-CN/updating.md)。维护本仓库先读 [AGENTS.md](AGENTS.md)，在其他项目使用工作流先读[主控 Skill](skills/orchestrate-code/SKILL.md)。

## 文档

| 内容 | 简体中文 | English |
|---|---|---|
| 文档目录 | [目录](docs/zh-CN/README.md) | [Index](docs/en/README.md) |
| 安装与配置 | [首次接入](docs/zh-CN/getting-started.md) | [Getting started](docs/en/getting-started.md) |
| 日常操作 | [日常使用](docs/zh-CN/daily-guide.md) | [Daily guide](docs/en/daily-guide.md) |
| 项目默认值与简短合同 | [仓库偏好](docs/zh-CN/repository-preferences.md) | [Repository preferences](docs/en/repository-preferences.md) |
| 恢复、多任务和排错 | [进阶使用](docs/zh-CN/advanced-guide.md) | [Advanced guide](docs/en/advanced-guide.md) |
| 后台行为与限制 | [架构与执行行为](docs/zh-CN/architecture.md) | [Architecture](docs/en/architecture.md) |
| 任务契约与报告 | [交接协议](docs/zh-CN/protocol.md) | [Protocol](docs/en/protocol.md) |

## 目录结构

```text
docs/                英文与简体中文指南
src/                 调度、MCP 工具、worker 与协议校验
test/                自动化测试与本地 fixture
scripts/             接入、诊断、构建检查与 Windows 内存监护
skills/              公共主控 Skill 与 Codex 调用元数据
prompts/             实现与只读调查角色提示词
integrations/        Claude 插件、MCP 模板与忽略的本地输出
examples/            任务契约示例
workflow.config.json 共享工作流配置
.env.example         环境变量模板
```

`dist/`、`node_modules/`、`.runtime/`、`work/`、`worktrees/`、`integrations/local/`、`.env.local` 和 `workflow.local.json` 属于本地或生成数据，已由 Git 忽略。另见[接入文件说明](integrations/README.md)和[任务示例说明](examples/README.md)。

## 开发

```powershell
npm test
```

测试使用临时仓库、本地模拟模型接口和随依赖安装的 OpenCode，不调用付费模型 API。构建输出在 `dist/`，测试临时目录在 `work/workflow-tests/`。修改公共 Skill 或移动安装目录后，运行 `node scripts/prepare-integrations.mjs`。

worker 可使用本地工具；Git worktree 和 OpenCode 权限不是操作系统沙箱。请用于受信任的仓库，并阅读[执行边界](docs/zh-CN/architecture.md)。主控订阅与 worker API 用量分别计费。
