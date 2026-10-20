# Client integrations / 客户端接入

[English setup](../docs/en/getting-started.md) | [中文安装指南](../docs/zh-CN/getting-started.md)

| Path | Purpose / 用途 |
|---|---|
| `claude/` | Claude plugin and explicit Skill derived from the shared Skill / Claude 插件与公共 Skill 派生版本 |
| `claude.mcp.example.json` | Portable Claude MCP template / 可发布的 Claude MCP 模板 |
| `codex.mcp.example.toml` | Portable Codex MCP template / 可发布的 Codex MCP 模板 |
| `local/` | Generated machine-specific files, ignored by Git / 本机生成文件，不纳入 Git |

From the installation root / 在安装根目录运行：

```powershell
node scripts/prepare-integrations.mjs
```

This refreshes the Claude Skill, generates `local/claude.mcp.json` and `local/codex.mcp.toml` with actual Node/installation paths, and localizes the alpha draft's check-script paths in `local/alpha-244.json`. Existing local task settings, including your repository path, are retained. A fresh draft contains a placeholder repository path you must edit before use. The tracked example is never rewritten.

脚本更新 Claude Skill，按当前 Node 与安装目录生成本地 MCP 文件，并将 alpha 草案中的检查脚本路径本地化。已有本地任务设置（包括仓库路径）会保留；首次生成的仓库路径是占位值，使用前必须修改。仓库内示例不会被重写。

It does not install client settings or start workers. Use `npm run install:claude` for user-level Claude installation, or merge `npm run connections` output manually. Template files use placeholder paths; do not register them unchanged. Rerun preparation after moving the installation, then update any previously registered client paths.

它不安装客户端设置，也不启动 worker。Claude 用户级安装使用 `npm run install:claude`；也可手动合并 `npm run connections` 输出。模板含占位路径，不可原样注册。移动目录后重新生成，并更新已注册的客户端路径。

Edit `skills/orchestrate-code/SKILL.md` as the source of supervisor instructions, then regenerate the Claude variant. Keep both Skill directories in place: clients load their frontmatter and metadata directly. No API keys belong in MCP files.

主控指令源文件为 `skills/orchestrate-code/SKILL.md`，修改后重新生成 Claude 版本。两处 Skill 都保留在功能目录，供客户端直接读取元数据。MCP 文件不应包含 API Key。
