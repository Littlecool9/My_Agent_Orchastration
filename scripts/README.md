# Scripts / 脚本

Run setup scripts from the repository root. Task checks run in the target workspace. / 接入脚本在仓库根目录运行，任务检查在目标工作目录运行。

| Script | Purpose / 用途 |
|---|---|
| `../setup.ps1`, `setup.mjs` | Unified interactive/non-interactive installer; Node is checked only / 统一交互或带参数安装入口，仅检查 Node |
| `../update.cmd`, `../update.ps1`, `update.mjs` | Explicit updater and read-only `--check`; preserves local state and refreshes managed clients / 显式更新与只读检查，保留本地状态并同步已管理客户端 |
| `setup-lib.mjs`, `install-client.mjs` | Shared tool resolution, ownership/conflict checks and recoverable client registration / 工具定位、归属检查及可恢复的客户端注册 |
| `prepare-integrations.mjs` | Generate local MCP files and the Claude Skill; never installs client settings / 生成本地接入文件及 Claude Skill，不安装客户端配置 |
| `install-claude.mjs`, `install-codex.mjs` | Install/repair user MCP and Skill; support `--dry-run` / 安装或修复用户级接入，支持预览 |
| `start-claude.ps1` | Temporarily load the Claude plugin for a target project / 为目标项目临时加载插件，供排错 |
| `worker-job.ps1`, `worker-job.cs` | Internal Windows Job Object guard used by worker startup / worker 启动使用的内部内存监护组件 |

Repository-specific check scripts, test fixtures and drafts live in their local repository profile under `skills/orchestrate-code/repositories.local/<id>/`. Read [repository preferences](../docs/en/repository-preferences.md) for `profile://scripts/<file>` references.

项目专用检查脚本、测试及任务草案存放在各自的本地 repo profile。通过 `profile://scripts/<file>` 引用，详见[仓库偏好](../docs/zh-CN/repository-preferences.md)。

`npm run setup` installs the backend and selected integrations without generating examples or creating repository profiles. `npm run setup:check -- --provider deepseek` checks the local guard and MCP without model requests. Normal use does not require launching OpenCode or the guard manually. Read [setup](../docs/en/getting-started.md) / [安装与配置](../docs/zh-CN/getting-started.md).

`npm run setup` 安装后端及所选接入，不生成项目示例或创建 repository profile。`npm run setup:check -- --provider deepseek` 本地检查监护及 MCP，不请求模型。日常使用无需手动启动 OpenCode 或监护组件。移动安装目录后重新运行 setup 更新已管理的连接路径。
