# Scripts / 脚本

Run setup scripts from the repository root. Task checks run in the target workspace. / 接入脚本在仓库根目录运行，任务检查在目标工作目录运行。

| Script | Purpose / 用途 |
|---|---|
| `prepare-integrations.mjs` | Generate local MCP files and the Claude Skill; never installs client settings / 生成本地接入文件及 Claude Skill，不安装客户端配置 |
| `install-claude.mjs` | Install user-level Claude MCP and Skill; supports `--dry-run` / 安装用户级接入，支持预览 |
| `start-claude.ps1` | Temporarily load the Claude plugin for a target project / 为目标项目临时加载插件，供排错 |
| `alpha-check.ps1` | Alpha-specific CMake/CTest helper; `Target` and `TestRegex` select incremental checks / alpha 专用构建测试，两个过滤参数须配对 |
| `worker-job.ps1`, `worker-job.cs` | Internal Windows Job Object guard used by worker startup / worker 启动使用的内部内存监护组件 |

Normal use does not require launching OpenCode or the guard manually. Read [setup](../docs/en/getting-started.md) / [安装与配置](../docs/zh-CN/getting-started.md) before installing integrations.

日常使用无需手动启动 OpenCode 或监护组件。移动安装目录后重新生成本地接入文件，并更新已注册的客户端连接路径。
