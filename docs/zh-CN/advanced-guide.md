# 进阶使用指南

[English](../en/advanced-guide.md) | [文档目录](README.md)

你日常只和 Claude 主控对话：说明目标、回答关键问题、审查结果。Claude 负责生成任务契约、调用 OpenCode、安排返工和验收；你不需要打开 OpenCode 窗口，也不需要自己填写 JSON。

本文按已完成首次接入、API 探针通过且你已授权实际执行的状态介绍。第一次使用先看 [首次验证指南](getting-started.md)。以有效配置和 workflow_config 的运行值为准；阅读本文或创建任务记录不会派发任务。

## 1. 每次怎么打开

完成[安装与配置](getting-started.md)中的用户级接入后，在开发仓库打开终端，运行 `claude`，再使用 `/orchestrate-code`。Windows Terminal 用户可在资源管理器地址栏输入 `wt`。首次连接异常时用 `/mcp` 检查 `agent-orchestrator`。普通聊天不会自动委派。

| 接入方式 | 入口 |
|---|---|
| Claude 用户级或项目级 Skill | `/orchestrate-code` |
| 临时加载的 Claude 插件（排错） | `/agent-orchestrator:orchestrate-code` |
| Codex MCP 和 Skill | `$orchestrate-code` |

临时加载插件时，在工作流安装目录运行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-claude.ps1 -ProjectPath C:/path/to/your-project
```

## 2. 怎么下发一个任务

默认执行侧为 DeepSeek；workerChecks 仅增量，checks 由主控按风险选择执行。worktree 推荐但不强制，branch/current 也受支持。

最实用的信息是：目标、基线、范围、验收标准，以及是否允许 commit/push。模型选择可以明确写 Kimi 或 DeepSeek。没必要把所有实现步骤都替主控写好。

可直接套用：

```text
/orchestrate-code
处理 <仓库及 issue / 功能目标>。
基线用 <origin/master 或明确的功能分支>，先确认所需基础代码存在。
你负责规划和独立验收，把主要实现交给默认 DeepSeek。
范围：<要做什么；明确不做什么>。
验收：<可观察的结果、应运行的构建和测试>。
推荐独立 worktree，也可选择 branch/current；直接修改主分支先展示警告。按工作目录安排 build 目录；遵守对应 AGENTS.md。
除关键产品、架构或范围决策外自行推进，常规失败自行修复或派回返工。
完成后中文汇总实际结果、风险和需要我审核的设计决定。
不要 commit、push、创建 PR 或关闭 issue。
```

最后一行是这份模板的默认交付边界。如果某次要提交代码，可以在那次任务中明确允许 commit；push/PR 等也要按你的实际意图说明。执行 agent 的默认提示词不允许自行发布。

项目专用草案放在 `skills/orchestrate-code/repositories.local/<id>/examples/`。主控先读取绑定的 profile，核对当前仓库规则和 issue 要求，再调整草案；本地检查脚本用 `profile://scripts/<file>` 引用。详见[仓库偏好](repository-preferences.md)。

## 3. 一个 milestone 怎么下发

```text
/orchestrate-code
处理 <milestone 名称> 中的 issues <编号列表>，基线为 <分支>。
先调查依赖、适用的 AGENTS.md 和验收要求，形成分阶段计划。
独立任务才并行；有依赖的任务先确定包含前置代码的基线。
你负责总体设计、任务契约和独立验收；执行侧默认 DeepSeek。
默认自行执行和返工，只把关键决策集中问我。
并行任务使用不同目录（推荐 worktree）；同目录分支任务串行。worker 只跑增量测试，主控自主选择独立及组合验证范围。
不要 push。最后按 issue、分支、测试结果、风险与待审核设计决定汇总。
```

如果这次希望“批准计划后再写代码”，增加一句：**先汇总澄清问题和实施计划，等我明确批准后才开始改代码。** 不写这句时，按原任务授权自动推进，只就关键决策找你。

当前版本会检查任务依赖，但不会自动把多个 worktree 的源码合并。主控需要选择正确的集成基线、处理整合并运行组合测试；依赖代码如需 commit，必须先获得该次任务的相应授权，不能与“不 commit”要求冲突。

## 4. 执行期间怎么交流

任务开始以后继续用中文说明即可。涉及工作流调度时，可以再次显式带上技能入口：

| 你的目的 | 可以这样说 |
|---|---|
| 看进度 | “查看当前任务状态，只汇总有变化的结果、阻塞和下一步。” |
| 补充验收要求 | “新增要求是……请先判断是否影响当前计划；需要修改时先停止相关执行，再更新计划版本。” |
| 指出问题 | “AC-02 还没满足：……请检查代码和证据，形成具体返工意见，继续原执行会话。” |
| 看设计决策 | “列出本次你和执行者做出的设计决定，以及各自依据。” |
| 只调查 | “先做只读调查，不修改代码、不运行会产生文件的构建；给我结论与代码位置。” |

你指出问题之后，主控负责把它转换成引用验收 ID 的结构化反馈。你不需要记住 JSON 字段或亲自调用 MCP 工具。

“我觉得应该这样做”可能改变计划；“实现里少了一个边界检查”通常属于原计划内返工。主控应先区分两者，避免执行者拿着过期计划继续干。

## 5. 遇到这些状态是什么意思

| 状态 | 意味着什么 | 通常怎么处理 |
|---|---|---|
| `planned` | 契约已记录，还没建工作树 | 主控检查计划后 prepare |
| `ready` | 工作树已准备，可派发 | 主控 dispatch |
| `running` | 执行 agent 正在工作 | 等待有意义的进展 |
| `awaiting_review` | 执行者提交了完整结果 | 主控读代码、运行独立验证 |
| `verifying` | 正在真实运行验证命令 | 等待退出码和日志 |
| `needs_changes` | 主控验收发现问题 | 带具体验收 ID 反馈，继续原会话 |
| `needs_replan` | 发现设计/范围/约束冲突 | 主控更新计划；必要时找你决定，不能直接重跑旧计划 |
| `blocked` | 环境、权限或依赖挡住执行 | 主控诊断；修复后带诊断反馈重派 |
| `failed` | 执行错误或结果不符合协议 | 主控查看错误与本轮报告，诊断后决定是否重试 |
| `interrupted` | 后台停止或中断，完成状态不确定 | 检查已有改动，再明确恢复 |
| `accepted` | 主控已完成该任务验收 | 审查最终交付；不代表已 commit/push |
| `cancelled` | 该任务已被取消 | 保留文件；当前实现不直接恢复 cancelled 任务 |

主控可反复检查、验证和要求返工，直到满足验收条件，正常返工不限轮数。maxAttempts 默认 5，仅限制 failed/interrupted/blocked 后的累计恢复派发次数，不包含首次执行和正常返工。每次恢复需提供结构化诊断反馈；修改计划、正常完成和重启都不清零恢复计数。达到恢复上限时主控应分析问题、必要时接管局部修复，不能重建相同任务绕过预算。workflow_status 用 attempts 记录总轮次，recoveryAttempts/recoveryAttemptLimit/remainingRecoveryAttempts 记录异常恢复预算；旧任务缺少恢复计数时从 0 开始记录，历史轮次保留。

## 6. 下班、关闭窗口和第二天继续

**只关闭 Claude 窗口时：** 已派发的后台任务可能继续运行并产生 API 用量。执行者可以完成当前轮次，但没有在线主控就不会继续下一轮验收和调度。你希望它继续跑时，可以这样退出。

**希望停止全部后台工作时：** 在工作流文件夹的 PowerShell 执行：

```powershell
npm run stop
```

它会停止当前后台执行并保留源码和记录，不回滚代码；下次需由主控检查后恢复，重派会消耗一次异常恢复额度。后台关闭后，下一次工作流调用仍可能自动启动它。若希望持续禁止新的执行，将有效配置中的 executionEnabled 改为 false，并确保后台已停止或已重启加载新配置。

**第二天恢复：** 用第 1 节的命令重新打开 Claude，然后发送：

```text
/orchestrate-code
恢复之前的任务 <task-id>；如果我没记住 ID，先列出现有任务。
先读取任务状态、最新计划和必要的结果摘要，检查 worktree 实际改动。
不要重新创建相同任务，也不要从头复制整段执行日志。
如果已待验收就继续验收；如果中断就先诊断，再在原会话中明确恢复。
```

如果只想停一个任务，可以让主控调用 workflow_cancel；但它是取消，不是可无损恢复的“暂停”。需要暂时保留任务继续工作的可能性时，先让主控说明当前状态再选停止方式。

## 7. 怎么看最终交付

日常看主控给你的简洁中文结果，至少包括：issue/任务、分支与基准提交、实际验证结果、风险、设计决定，以及是否已经 commit/push。

需要追查证据时，查看工作流文件夹里的这些位置：

| 路径 | 内容 |
|---|---|
| `worktrees/<task-id>/` | worktree 模式的源码改动；branch/current 使用原检出目录 |
| `.runtime/tasks/<task-id>/task.json` | 当前状态、计划、会话和审核记录 |
| 同目录 `contract.json` | 最近一次派发的任务契约；当前最新计划以 task.json 为准 |
| 同目录 `report.json` | 执行者的结构化报告；报告本身不等于独立验收 |
| 同目录 `worker-report.md` | 报告的可读摘要 |
| 同目录 `verify-*.log` | 主控通过程序真实运行的验证日志 |
| 同目录 `events.jsonl` | 派发、改计划、验收等事件 |

主控应实际检查新增文件和 diff，不能只看“已完成”或一段测试成功描述。项目要求的检查必须通过；缺环境就报告 blocked，不能当作测试通过。

## 8. 换模型或改配置

新任务直接说“执行侧用 DeepSeek”或“执行侧默认 DeepSeek”，主控会选对应 provider。前提是相应 Key 已配置。订阅主控和执行 API 分别计费；custom provider 报告中的 cost=0 不代表供应商免费。

对**已经创建的任务**，provider 和基准分支属于执行身份，当前版本不能直接改。让主控说明迁移方案，再创建不同任务并处理已有改动，不要假定修改配置就会把原会话自动切到另一家模型。

修改 Key、endpoint、model 或并行上限后，在没有其他任务运行时从工作流文件夹执行：

```powershell
npm run stop
npm run start
```

`workflow.local.json` 存在时会完整替代 `workflow.config.json`，不是仅覆盖几个字段。别编辑了基础文件，却忘了本地文件仍然生效。不要在执行中直接修改现有 provider 的 model/endpoint 来替换一个活动任务的执行身份。

换供应商、Key 或模型后，必要时再运行一次显式 `--live` 探针；不用每个任务都做。探针只验证连接、工具调用和报告协议，业务质量仍由实际任务验收。

## 9. 常见问题

| 现象 | 先怎么处理 |
|---|---|
| Skill 命令找不到 | 确认用户级 MCP/Skill 已安装并重新打开会话；临时插件入口有 `agent-orchestrator:` 前缀 |
| MCP 工具不可见 | `/mcp` 查看连接；确认工作流文件夹未移动，dist 已构建 |
| Execution is disabled | 确认你已决定开工，再修改有效配置的开关并重启后台 |
| Missing Key | 在 `.env.local` 填对应 Key，再重启后台；不要把 Key 放进任务 prompt |
| 401/403 或模型不可用 | 检查 Key 所属区域、endpoint、模型权限；停止盲目重试 |
| 429 | 主控诊断限速/配额；必要时调低并行或稍后重试 |
| 报告不是严格 JSON / 版本不匹配 | 主控查看本轮 response 与 raw-report 工件；诊断提示词或协议，不能把普通文本强行判作成功 |
| 任务因构建环境阻塞 | 查看日志与所需工具链/环境变量，不要让执行者省略验收命令 |
| 分支或工作树路径已存在 | 先核对现有任务与已有代码；不要直接删掉或重新建相同任务 |
| 达到异常恢复上限 | 让主控总结失败原因并做决策，不要重复创建相同任务绕过预算；正常审查返工不限轮数 |

日常排错优先让主控读有针对性的摘要和日志片段。完整 transcript 留给具体问题诊断，避免重新把全部执行细节塞回主控上下文。

CLI 排错可从文件读取请求，避免 shell 的 JSON 转义：

```powershell
node dist/src/cli.js call TOOL_NAME --file C:/path/to/request.json
```

## 相关资料

- [首次验证指南](getting-started.md)：第一次填 Key、探针、接入和启动 #244。
- [交接协议](protocol.md)：计划版本、验收 ID、结果格式和改计划机制。
- [工作流规则](../../skills/orchestrate-code/SKILL.md)：主控实际遵循的指令。
- [架构与执行边界](architecture.md)：后台行为、内存限制及已知边界。
