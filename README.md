# Local Agent Orchestrator

**English** | [简体中文](README.zh-CN.md)

A local MCP workflow that lets your Claude Code or Codex supervisor delegate coding work to OpenCode workers, then independently review and verify the result. Keep your existing supervisor model and subscription; workers use separately configured model APIs.

The project is under active development. Worker execution currently requires **Windows**, where a Job Object enforces each worker's memory limit.

## Features

- Versioned task contracts with explicit scope, decisions, acceptance criteria and evidence.
- Per-repository preferences with automatic contract resolution, immutable snapshots and explicit validation policy.
- Isolated Git worktrees, a new branch in the original checkout, or the current branch.
- Persistent tasks and sessions for review, rework and interrupted-run recovery.
- Incremental worker checks and independent supervisor verification.
- DeepSeek for new tasks by default, with explicit Kimi selection.
- A default 3 GiB committed-memory limit per worker and its ordinary build/test descendants.

```text
Claude Code / Codex supervisor
  -> explicitly invoked Skill + MCP bridge
    -> local scheduling daemon
      -> OpenCode worker -> configured model API
    <- structured report -> independent review and verification
```

## Quick start

Install Node.js 22+, Git, and your supervisor client. From this repository's root:

```powershell
npm ci
npm run build
node scripts/prepare-integrations.mjs
if (-not (Test-Path .env.local)) { Copy-Item .env.example .env.local }
npm run doctor
```

Fill in the selected provider's key in `.env.local`. Review `executionEnabled` in the effective configuration before dispatching. The checked-in file currently sets it to `true`; adding a key, starting the daemon or creating a task does not dispatch a task by itself.

For Claude Code, run `npm run install:claude` once, reopen Claude in your target repository, and invoke:

```text
/orchestrate-code Implement <goal> from <baseline>. Delegate implementation to DeepSeek, review the diff, and independently verify the result. Do not commit or push.
```

For Codex, run `npm run connections`, merge the printed MCP table into your configuration, and install `skills/orchestrate-code/`. Invoke `$orchestrate-code` explicitly. See [installation and configuration](docs/en/getting-started.md) for full setup and optional live validation.

## Documentation

| Guide | English | 简体中文 |
|---|---|---|
| Documentation index | [Index](docs/en/README.md) | [目录](docs/zh-CN/README.md) |
| Installation and configuration | [Getting started](docs/en/getting-started.md) | [安装与配置](docs/zh-CN/getting-started.md) |
| Everyday use | [Daily guide](docs/en/daily-guide.md) | [日常使用](docs/zh-CN/daily-guide.md) |
| Project defaults and short contracts | [Repository preferences](docs/en/repository-preferences.md) | [仓库偏好](docs/zh-CN/repository-preferences.md) |
| Recovery, milestones and troubleshooting | [Advanced guide](docs/en/advanced-guide.md) | [进阶使用](docs/zh-CN/advanced-guide.md) |
| Runtime behavior and limitations | [Architecture](docs/en/architecture.md) | [架构与执行行为](docs/zh-CN/architecture.md) |
| Task contracts and reports | [Protocol](docs/en/protocol.md) | [交接协议](docs/zh-CN/protocol.md) |

## Repository layout

```text
docs/                English and Simplified Chinese guides
src/                 Scheduler, MCP tools, workers and protocol validation
test/                Automated tests and local fixtures
scripts/             Setup, diagnostics, build checks and Windows memory guard
skills/              Shared supervisor Skill and Codex invocation metadata
prompts/             Executor and investigator role prompts
integrations/        Claude plugin, MCP templates and ignored local outputs
examples/            Task contract examples
workflow.config.json Shared workflow configuration
.env.example         Environment variable template
```

`dist/`, `node_modules/`, `.runtime/`, `work/`, `worktrees/`, `integrations/local/`, `.env.local` and `workflow.local.json` are local or generated data ignored by Git. See [integration files](integrations/README.md) and [task examples](examples/README.md).

## Development

```powershell
npm test
```

The suite uses temporary repositories, local fake model endpoints and the bundled OpenCode executable. It does not call paid model APIs. Build output goes to `dist/`; fixtures live under `work/workflow-tests/`. Run `node scripts/prepare-integrations.mjs` after editing the shared Skill or moving the installation.

Workers can use local tools; Git worktrees and OpenCode permissions are not an OS sandbox. Use trusted repositories and review the [execution boundaries](docs/en/architecture.md). Supervisor subscription use and worker API usage are billed separately.
