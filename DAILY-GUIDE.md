# 日常使用：保持你原来的习惯

## 每次只做这三步

1. 在资源管理器打开你要开发的项目，例如 alpha。
2. 地址栏输入 **wt**，打开终端后输入 **claude**。
3. 进入 Claude 后，用 **/orchestrate-code** 加上任务描述。

例如：

```text
/orchestrate-code 帮我处理 alpha #244，从最新 master 开始。你负责规划和验收，把实现交给 Kimi K3，只在关键决策时问我。不要 commit 或 push。
```

普通聊天直接说话；要用这套委派工作流时才加 /orchestrate-code。不用进入工作流文件夹，不用运行启动脚本，不用手动打开 OpenCode，也不用填写任务 JSON。

## 第一次开工前

当前已检测到 Kimi 和 DeepSeek 的本地 Key，迁移时原样保留，不用重复填写。Key 是否有效需通过显式 API 探针确认；执行开关的运行值以 workflow_config 为准。

API Key 只填一次，文件在：

`D:\desktop\programming\personal-projects\agents-related\agent-orchestrator\.env.local`

先填 MOONSHOT_API_KEY 即可，DeepSeek 暂时不用可以留空。Key 不用发到聊天里。首次安装时执行开关默认关闭；填完后告诉主控“API 已配好，先验证连接，再启用工作流”，确认成功后再明确开始 #244。填 Key 本身不会启动任务。

用户级 MCP 和显式调用技能注册后，普通 claude 启动就能找到它们。已经开着的 Claude 会话需要退出后重新打开。若命令没出现，先输入 /mcp 检查 agent-orchestrator 是否连接。

## 提示执行关闭，但文件里已经是 true

这是后台还没重新读取配置。让主控调用 workflow_config：executionEnabled 是运行值，diskExecutionEnabled 是磁盘值，restartRequired=true 表示需要重启。configFile 显示当前选用的文件；workflow.local.json 不存在是正常的，不需要为了开执行新建它。

在没有任务正在执行或验证时，可以让主控直接在工作流安装目录依次运行 npm run stop 和 npm run start，再检查 workflow_config。已经明确授权开工时，这属于正常排错。重启保留已有任务；继续原任务的 prepare，不要重新创建。通常无需退出 Claude 或重连 MCP。

如果使用 workflow.local.json，它必须包含完整配置，不能只写 { "executionEnabled": true }。

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

看主控给你的：改了什么、实际构建/测试结果、风险、设计决定、源码分支和 worktree 位置。执行者说“完成”后，主控还需要独立验收。

项目位置：`D:/desktop/programming/personal-projects/agents-related/agent-orchestrator`。

需要排错或理解状态时再看 [详细说明](ADVANCED-GUIDE.md)、[首次验证](START-VERIFY.md) 和 [交接协议](PROTOCOL.md)。
