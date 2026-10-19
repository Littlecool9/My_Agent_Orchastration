# 如何开始验证 v0.2

以下是首次验证流程，初次安装默认 executionEnabled=false。当前运行状态请调用 workflow_config 查看；磁盘配置变化后需要重启 daemon 才生效。以下命令由你在准备好之后执行。

## 1. 填 Key，做本地检查

在本文件夹的 `.env.local` 填写 MOONSHOT_API_KEY；首轮只验证 Kimi 时，DeepSeek 可以留空。默认使用中国开放平台 `https://api.moonshot.cn/v1`、`kimi-k3`。如果 Key 来自国际站，先在配置里改 endpoint。密钥不用发到聊天。

```powershell
Set-Location -LiteralPath 'D:\desktop\programming\personal-projects\agents-related\agent-orchestrator'
npm run doctor
```

预期：OpenCode 版本可读，kimi.apiKeyPresent=true，executionEnabled=false。本地依赖已经装好；只有缺少依赖或换机器才需要 npm ci，再 npm run build。

## 2. 单独检查 API、工具调用和结构化返回

下面这条会产生少量真实模型费用，但只在工作流自己的临时目录读取随机 marker 文件，不访问 alpha、不创建 alpha 分支，也不打开项目执行开关：

```powershell
npm run probe -- --provider kimi --live
```

成功时显示 passed=true、toolCallObserved=true、structuredReportValidated=true，并给出本地 report.json 路径。探针同时验证：当前 Key/model 可用、自定义 investigator 能调用 read、返回 JSON 符合 Schema、taskId/planRevision/runId/attempt 匹配、报告包含真实工具读取的随机值。不是只检查“模型能回一句话”。

可选的 DeepSeek 验证：`npm run probe -- --provider deepseek --live`。没有 --live 会直接拒绝，doctor/npm test 都不会请求真实模型。

失败时按错误定位：Missing Key → 填 .env.local；401/403 → Key/区域/模型权限；429 → 配额/限速；严格 JSON 报告错误 → 查看 `.runtime/workers/probe-*/response-1.json`，不要把包含私人信息的完整日志贴到公开位置。失败不会自动换模型或消费主控订阅。

## 3. 照常打开 Claude，先检查接入

用户级 MCP 和显式技能完成一次安装后，你的启动习惯不变：资源管理器进入 alpha，地址栏输入 wt，终端输入 claude。不需要额外脚本或插件参数。旧会话请退出后重开。

进入后用 /mcp 检查 agent-orchestrator，应该能看到 12 个工具。然后发送：

```text
/orchestrate-code 先只检查工作流配置和 alpha #244 任务契约，不要执行任务。
```

首次在其他机器安装时，在工作流文件夹运行 npm run install:claude 即可。这一步不改变主控模型或订阅登录。

## 4. 你明确开工后，再开启 #244

探针和接入都成功，且你决定开始实际验证时：

1. 编辑 workflow.config.json，将 executionEnabled 改为 true。如果 workflow.local.json 存在，需要编辑它，因为它完整覆盖基础配置。
2. 在另一个 PowerShell 中运行 npm run stop，再 npm run start，让 daemon 重新读取配置和 Key。不要在有其他任务运行时重启。
3. 在上述 Claude 会话里发送下面的明确启动指令。

```text
/orchestrate-code 现在开始用这套工作流验证 alpha #244。任务草案位于 D:/desktop/programming/personal-projects/agents-related/agent-orchestrator/examples/alpha-244.json。你继续负责规划和验收，通过自定义 executor 将实现交给 Kimi K3。fetch 后从最新 origin/master 创建独立 worktree，记录基准提交；在该 worktree 重新读取 #244/#230 和适用的 AGENTS.md，把必要设计写入带版本的任务契约。只在关键决策时找我。执行、返工和结果必须使用当前计划版本与验收项 ID；需要改计划时使用 workflow_plan_update。Debug/Release 构建和全部测试通过后独立验收。不要 commit、push、创建 PR 或关闭 issue。
```

构建环境需要 MSVC C++、CMake、Ninja、VCPKG_ROOT、VULKAN_SDK 及项目 Wwise 配置。构建失败不算完成；执行者应返回 blocked 或在本地修复，不能省略检查。

## 5. 检查真正的交接与验收证据

任务记录在 `.runtime/tasks/alpha-prefabs-244/`，源码位于 `worktrees/alpha-prefabs-244/`。

| 证据 | 应看到什么 |
|---|---|
| contract.json / contract-run-UUID.json | 当前任务与计划版本、执行轮次、固定设计、局部权限、基准提交和验收 ID |
| report.json | 按验收 ID 报告结果；只能 ready_for_review / blocked / needs_replan |
| task.json / events.jsonl | 模型完成后仍待验收；主控独立验证和 review 决定可追溯 |
| verify-*.log | 主控通过程序独立运行的真实检查结果，不是模型口述 |
| reviews / plan 更新事件 | 返工具体到验收项；计划改动单独递增 planRevision，不与状态 revision 混用 |

如果执行者发现主计划冲突，应停在 needs_replan，不能直接原计划重试；主控更新完整契约后才可继续，原会话和 worktree 保留。并非每个任务都会自然触发返工/改计划，不要故意破坏 alpha 来制造测试场景。离线测试已经覆盖这些状态路径，真实 #244 主要检查模型是否遵守分工、交付质量，以及主控上下文是否保持清晰。

暂停或结束时 `npm run stop` 会停止后台进程并保留文件；它不回滚修改。若要阻止后续执行，把 executionEnabled 改回 false 并重启 daemon。
