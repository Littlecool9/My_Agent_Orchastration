# 日常使用

[English](../en/daily-guide.md) | [文档目录](README.md)

## 每次只做这三步

1. 在资源管理器打开你要开发的项目。
2. 打开终端，输入 **claude**。安装了 Windows Terminal 时，可在地址栏输入 **wt**。
3. 进入 Claude 后，用 **/orchestrate-code** 加上任务描述。

例如：

```text
/orchestrate-code 从 <基线> 实现 <目标>。你负责规划和独立验收，把实现交给 DeepSeek，只在关键决策时问我。不要 commit 或 push。
```

普通聊天直接说话；要用这套委派工作流时才加 /orchestrate-code。不用进入工作流文件夹，不用运行启动脚本，不用手动打开 OpenCode，也不用填写任务 JSON。Codex 用户完成接入后使用 `$orchestrate-code`。

## 默认行为与目录选择

默认用 DeepSeek deepseek-flash。worker 只跑增量测试；Claude 主控自行选择验证方法和范围，不再强制全量。大型项目可选受影响模块、目标回归或冒烟，说明选择理由和没测到的部分；修复后重跑相关检查，是否扩大范围由主控判断。

每个 worker（含其编译/测试子进程）默认 3 GiB 内存预算，可在配置中修改 workerMemoryLimitMB。触及限额会终止整组并保留源码、会话和内存工件，主控诊断后再恢复。默认两路并行时，这是每路 3 GiB。

worktree 只是推荐。你也可以直接说：

- `/orchestrate-code 实现……，就在这个目录新建分支，不用 worktree。`
- `/orchestrate-code 实现……，直接用当前分支；如果是主分支，先提醒我再修改，不用额外确认。`

同一检出目录只允许一个任务占用。目录已有改动时先保留处理，或改用 worktree；工作流不会自动 stash、reset 或覆盖它们。

## 第一次开工前

按[安装与配置](getting-started.md)完成首次安装。Key 是否有效需通过显式 API 探针确认；执行开关的运行值以 workflow_config 为准。

API Key 只填一次，文件在：

安装目录下的 `.env.local`

默认模型先填 DEEPSEEK_API_KEY；要选 Kimi 时再填 MOONSHOT_API_KEY。Key 不用发到聊天里。首次安装时先检查有效配置的 executionEnabled；需要先审查时将其设为 false。填完后告诉主控“API 已配好，先验证连接，再启用工作流”，确认成功后再明确开始任务。填 Key 本身不会启动任务。

用户级 MCP 和显式调用技能注册后，普通 claude 启动就能找到它们。已经开着的 Claude 会话需要退出后重新打开。若命令没出现，先输入 /mcp 检查 agent-orchestrator 是否连接。

## 提示执行关闭，但文件里已经是 true

这是后台还没重新读取配置。让主控调用 workflow_config：executionEnabled 是运行值，diskExecutionEnabled 是磁盘值，restartRequired=true 表示需要重启。configFile 显示当前选用的文件；workflow.local.json 不存在是正常的，不需要为了开执行新建它。

在没有任务正在执行或验证时，可以让主控直接在工作流安装目录依次运行 npm run stop 和 npm run start，再检查 workflow_config。已经明确授权开工时，这属于正常排错。重启保留已有任务；继续原任务的 prepare，不要重新创建。通常无需退出 Claude 或重连 MCP。

如果使用 workflow.local.json，它必须包含完整配置，不能只写 { "executionEnabled": true }。

## 主控如何选测试

你可以直接说“按改动风险选择验证，不用跑全量”。主控通过 workflow_verify 的 selection 记录策略、理由、检查命令和 omittedCoverage；无需为一次测试选择重写整个任务计划。默认 `commands_required` 要求独立命令通过；`review_allowed` 合同允许主控明确选择仅代码审查，并记录代码证据和未覆盖范围，见[仓库偏好](repository-preferences.md)。

## 等待结果与停止验证

在编排器安装目录运行：

```powershell
node dist/src/cli.js wait <task-id>
node dist/src/cli.js wait <task-id> --until change --after <task-id>=12 --timeout-ms 60000
```

默认不限总时长，任一所选任务进入需要主控介入的状态时返回：待审查、返工、重规划、阻塞、验收完成、失败、取消或中断。最多支持八个任务 ID。`--until change` 等待 revision 变化；未传 `--after` 时以首次快照为基线。输出为 JSON。退出码 0 表示等待条件满足，不代表任务通过验收；总超时退出码为 2，Ctrl+C 退出码为 130，只结束等待。CLI 会重试暂时断开的读取连接，不会重新派发任务。自动唤醒主控仍需宿主接入通知。

只想停止检查时，让主控调用 `workflow_verify_stop`，传入 `{id,reason}`。它等待检查进程树退出，保留已完成结果并回到 `awaiting_review`。每轮验证的独立工件和日志可在 `workflow_status` 中找到，后续验证不会覆盖旧轮次。中止的验证不满足验收要求；若该轮已经完成，停止操作保留其原结果。

主控整合修改和外部补测通过 `workflow_evidence_add` 追加。`entry` 包含 `planRevision`、`kind`（`integration`、`verification` 或 `note`）、`summary`、`criterionIds`、`evidence` 和可选 `log`。记录绑定当前源码指纹，取消任务后也能追加。它保存主控提供的证据，不执行命令或将验证标为通过。

仓库专用脚本优先由对应仓库维护。需要放在 Skill 旁边的本地脚本与 profile，统一存放在 `skills/orchestrate-code/repositories.local/<repository-id>/`，下设 `profile.json` 和 `scripts/`；该目录已加入 gitignore。通过 `workflow_repository_config` / `workflow_repository_config_update` 查看或明确修改偏好。新任务自动继承，并保存冻结的合同快照；创建时只必填 ID、仓库、目标和验收项。默认值、覆盖、硬上限及迁移见[仓库偏好](repository-preferences.md)。

## 执行中断后继续

先查询 workflow_status，不要重建任务或 worktree。failed / interrupted / blocked 的任务，主控需要审查已有改动，并在 workflow_dispatch 中提供匹配当前计划版本和验收项 ID 的结构化诊断反馈；继续原 session。needs_replan 则先更新计划。

恢复原会话前，后台会自动归档并删除无法重放的空 assistant 消息；工具调用记录保留。如果历史修复失败，应先修复工作流，不要直接反复派发或手工改数据库。

OpenCode 已改用异步提交和短轮询，整轮任务仍受 taskTimeoutMinutes 限制。轮询短暂失败只重试读取，不会重新发送任务。工作流基础设施故障如需补偿，由维护者记录单任务 infrastructureRetryCredits；attempts 和 runId 保留，不能手动归零。

## 常用说法

| 你想做什么 | 对主控说 |
|---|---|
| 新任务 | /orchestrate-code 实现……，基线……，验收要求…… |
| 先看计划 | /orchestrate-code 先调查并给我计划，等我批准再写代码 |
| 看进度 | 查看当前任务，只汇总进展、阻塞和下一步 |
| 发现问题 | 这里不符合要求：……请检查并派回返工 |
| 加需求 | 新增要求：……先判断是否需要修改计划 |
| 第二天继续 | /orchestrate-code 恢复上次任务，先检查已有状态和改动，不要从头重做 |
| 停下来 | 停止当前任务的执行，保留已有改动，告诉我以后怎么恢复 |

关闭 Claude 窗口后，已经派发的执行任务可能继续跑并产生 API 用量。希望停下时，先明确让主控停止；取消任务和停止后台的恢复方式不同，由主控说明后处理。

## 完成后看什么

看主控给你的：改了什么、实际构建/测试结果、风险、设计决定、工作目录模式、路径和分支。执行者说“完成”后，主控还需要独立验收。

以上 npm 命令在工作流安装目录运行；claude 则在你要开发的仓库中启动。

需要排错或理解状态时再看 [详细说明](advanced-guide.md)、[首次验证](getting-started.md) 和 [交接协议](protocol.md)。
