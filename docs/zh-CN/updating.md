# 更新已安装的工作流

[English](../en/updating.md) | [文档目录](README.md)

安装后的 Skill 是副本。修改或拉取本仓库不会刷新这个副本，也不会替换会话已经加载的指令或缓存的 MCP 工具说明。修改本地源码或收到新版本后，显式运行更新器。

## 更新入口

Windows 用户可以直接双击安装目录里的 `update.cmd`；窗口会保留，方便查看结果。也可以运行：

```powershell
.\update.ps1
npm run update
```

脚本按自身位置定位安装目录，从其他目录启动也能工作。默认 `--client auto` 只刷新归属标记指向本安装的客户端，不接管其他安装或覆盖无人管理的 Skill。可显式选择 `--client claude|codex|both|none`，其中 `none` 只更新后端。

```powershell
npm run update -- --check
npm run update -- --dry-run
npm run update -- --client both
npm run update -- --pull
```

`--check` 只读比较源码、生成版、已安装的指令，以及已记录的后端源码指纹；不查询远端版本，也不启动 daemon。`--dry-run` 预览步骤。只有显式加 `--pull` 才执行 `git pull --ff-only`，要求检出干净且当前分支有 upstream。默认应用当前本地源码，包括有意保留的未提交修改，不自动 stash 或 reset。

## 更新内容

更新器先检查所选客户端的归属与 MCP 冲突，再取得本安装的更新锁。它安全停止空闲 daemon，按需拉取源码，在依赖锁文件变化或尚无成功记录时安装锁定依赖，然后编译、生成 Claude Skill/MCP 模板，刷新用户级 Skill 和本工作流的 MCP 接入。已经匹配的 MCP 注册保持原值。原先运行的 daemon 在成功后重启，原先停止的则留待下次使用时启动。

密钥、`.env.local`、`workflow.local.json`、repo profile、目标仓库、worktree 和任务历史均保留。profile 不复制到客户端 Skill 目录。更新不请求模型、不派发任务，不安装 Node.js，也不改变主控账户或凭据。

`.runtime/update.json` 记录成功应用的源码与依赖指纹。`--check` 同时比较 Skill 内容和 Codex 调用元数据。文件更新完成后，已打开的会话仍可能保留旧指令：重新打开客户端，或重连 MCP 并再次调用 Skill。

## 活动任务与恢复

有 worker、验证或受锁保护的任务操作时，daemon 拒绝仅空闲停止，后端和客户端替换不会开始。更新期间禁止新启动 daemon。旧版 daemon 若还不支持这种安全停止，则保持运行：先完成活动任务，执行一次 `npm run stop`，再运行更新器。

依赖安装或编译失败时保留本地状态，不写入成功更新指纹。写入客户端前重新检查冲突；MCP 接入失败沿用安装器的归属与旧注册恢复机制。修复错误后重跑即可；失败更新已停止的 daemon 会保持停止。更新器崩溃留下锁时，先检查 `.runtime/update.lock/owner.json` 的 PID，确认进程已退出再移除旧锁，不删除运行中更新器的锁。

## Agent 从哪里了解用法

维护本仓库时，公共正文为 [AGENT.md](../../AGENT.md)；`CLAUDE.md` 通过 `@AGENT.md` 导入，`AGENTS.md` 为使用该文件名的客户端提供发现入口。文件发现依据见 [Claude 导入说明](https://code.claude.com/docs/en/memory#import-additional-files)和 [Codex 指令发现](https://learn.chatgpt.com/docs/agent-configuration/agents-md)。

在其他仓库使用本工作流的主控读取安装后的 `orchestrate-code` Skill，其启动步骤和功能表覆盖 profile、路径前缀、资源上限、等待、工件、验证、返工和更新。仅通过 MCP 接入的主控可从 `workflow_config.guidance` 找到绝对路径和等待／更新命令。worker 则读取角色提示词、解析后的任务合同，以及目标仓库的规则文件。
