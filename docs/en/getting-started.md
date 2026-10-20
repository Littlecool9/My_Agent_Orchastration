# Installation and configuration

**English** | [简体中文](../zh-CN/getting-started.md) | [Documentation](README.md)

## Requirements

Use Windows, Node.js 22+ and Git. Install Claude Code or Codex as your supervisor client. OpenCode is installed through npm dependencies. Worker startup currently refuses to run without the Windows memory guard.

## Install locally

From the repository root:

```powershell
npm ci
npm run build
node scripts/prepare-integrations.mjs
if (-not (Test-Path .env.local)) { Copy-Item .env.example .env.local }
```

The preparation script updates the Claude Skill derived from the shared Skill and writes machine-specific MCP connections and a localized task example to the ignored `integrations/local/` directory. It does not install client settings or start tasks. Rerun after moving the installation or changing the shared Skill; refresh registered client paths if the installation moved.

Edit `.env.local` locally:

```dotenv
DEEPSEEK_API_KEY=your-local-key
MOONSHOT_API_KEY=your-local-key
```

Only configure the provider you use. New tasks default to `deepseek`; Kimi tasks use `kimi`. Never put keys in task prompts or MCP configuration.

## Review configuration

The effective file is `workflow.local.json` when present, otherwise `workflow.config.json`. A local file must be a **complete configuration**, not a partial override. Keys and local configuration are ignored by Git.

| Setting | Current configuration / behavior |
|---|---|
| `executionEnabled` | The checked-in file sets `true`; use `false` for planning and review only |
| `maxParallel` | 2 simultaneous tasks |
| `maxAttempts` | 5 abnormal recovery dispatches; normal rework does not consume this budget |
| `taskTimeoutMinutes` | 90 minutes per run |
| `workerMemoryLimitMB` | 3072 MiB of committed memory per worker and its ordinary descendants |
| Default provider | `deepseek`, configured model `deepseek-flash` |
| Optional provider | `kimi`, configured model `kimi-k3` |

These names describe repository settings, not guaranteed account availability. Select a model your account supports. Kimi is configured for `https://api.moonshot.cn/v1`; international-service keys require the corresponding endpoint. There is no automatic provider or supervisor-subscription fallback.

Creating a task records a plan. Starting the daemon does not dispatch it. `prepare`, `dispatch` and `verify` reject execution while disabled.

```powershell
npm run doctor
npm run connections
```

`doctor` checks versions, configuration and key presence without printing keys or requesting a model. `connections` prints snippets with actual installation paths.

## Connect Claude Code

One-time user-level installation:

```powershell
npm run install:claude
```

This registers the `agent-orchestrator` stdio MCP server and installs the explicit `/orchestrate-code` Skill, preserving login, model and unrelated settings. Unmanaged Skills and conflicting MCP entries are not silently replaced; inspect reported conflicts. Preview without installing:

```powershell
node scripts/install-claude.mjs --dry-run
```

Open a new normal `claude` session in your target repository. Check `/mcp`, then invoke `/orchestrate-code`. Ordinary conversation does not opt into delegation.

For manual setup, merge the server entry from `npm run connections` or `integrations/local/claude.mcp.json`, preserving other servers. Copy `integrations/claude/skills/orchestrate-code/` to your project or user `.claude/skills/`. This variant uses `disable-model-invocation: true`.

For temporary session-local troubleshooting:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-claude.ps1 -ProjectPath C:/path/to/your-project
```

The temporary plugin entry is `/agent-orchestrator:orchestrate-code`.

## Connect Codex

Merge the `[mcp_servers.agent-orchestrator]` table printed by `npm run connections`, or generated in `integrations/local/codex.mcp.toml`, into your MCP configuration, preserving other entries. Copy the complete `skills/orchestrate-code/` directory to `~/.codex/skills/orchestrate-code/`.

Invocation metadata sets `allow_implicit_invocation: false`; call `$orchestrate-code` explicitly. Reopen the session and check that tools are visible. This adapter provides standard MCP configuration and Skill metadata; validate your own client/account connection before real tasks.

## Optional live API probe

After reviewing the endpoint, model and key, explicitly run:

```powershell
npm run probe -- --provider deepseek --live
# Or, with Kimi configured:
npm run probe -- --provider kimi --live
```

This makes a small billable API request. It creates a local marker fixture, checks a completed read-tool call and validates the structured report. It does not access the example's target repository or start its issue. Artifacts live in `.runtime/probes/`. Success verifies connectivity and reporting, not business-task quality.

## Start work and reload settings

Follow the [daily guide](daily-guide.md). Have the supervisor read `workflow_config` before dispatching. For the alpha draft, read [example instructions](../../examples/README.md), set the local repository path and review external issue/toolchain assumptions. It is not an automatic startup task.

After editing keys or configuration, restart only when no task is running or verifying:

```powershell
npm run stop
npm run start
```

`workflow_config` exposes running `executionEnabled`, `diskExecutionEnabled`, selected `configFile`, `restartRequired` and any `configError`. Restart preserves tasks without dispatching them; normally existing MCP connections can continue.
