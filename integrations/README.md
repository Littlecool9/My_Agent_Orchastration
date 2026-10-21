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

This refreshes the Claude Skill and generates `local/claude.mcp.json` and `local/codex.mcp.toml` with actual Node/installation paths. It never reads or generates project task examples; keep those in their [repository profile](../examples/README.md).

脚本更新 Claude Skill，按当前 Node 与安装目录生成本地 MCP 文件，不读取或生成项目任务示例；后者放在各自的[repo profile](../examples/README.md)。

It does not install client settings or start workers. Use `npm run setup` for the full installer, `npm run install:claude` / `npm run install:codex` for only user-level client integration, or merge `npm run connections` output manually. Both client installers support `--dry-run` and preserve matching registrations. Template files use placeholder paths; do not register them unchanged. Rerun setup after moving the installation to update managed client paths.

它不安装客户端设置，也不启动 worker。完整安装使用 `npm run setup`；仅用户级接入使用 `npm run install:claude` 或 `npm run install:codex`，均支持 `--dry-run` 并保留相同注册；也可手动合并 `npm run connections` 输出。模板含占位路径，不可原样注册。移动目录后重新运行 setup 更新已管理的连接。

Edit `skills/orchestrate-code/SKILL.md` as the source of supervisor instructions, then regenerate the Claude variant. Keep both Skill directories in place: clients load their frontmatter and metadata directly. No API keys belong in MCP files.

主控指令源文件为 `skills/orchestrate-code/SKILL.md`，修改后重新生成 Claude 版本。两处 Skill 都保留在功能目录，供客户端直接读取元数据。MCP 文件不应包含 API Key。

Regeneration does not refresh installed copies. Run `npm run update` (or double-click `update.cmd`) to rebuild and update managed clients; `npm run update -- --check` reports stale entries. See [updating](../docs/en/updating.md) / [更新工作流](../docs/zh-CN/updating.md).
