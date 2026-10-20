# 架构与执行行为

[English](../en/architecture.md) | [文档目录](README.md)

## 默认执行策略

- worker 只跑变更相关的增量测试（workerChecks）。主控根据风险、项目规模和耗时自主选择目标测试、受影响模块、冒烟、静态检查或全量，通过 workflow_verify 执行；不默认强制全量。主控须记录依据与未覆盖范围。
- workerMemoryLimitMB 默认 3072（3 GiB），限制每个 OpenCode 及其正常创建的编译/测试后代进程的合计提交内存。Windows Job Object 从进程执行前绑定，达到内存限额时结束整组并记录原因；guard 退出也会清理后代。守护组件本身、主控和其他应用不计入该 Job。默认两个 worker 并行时，各自有 3 GiB 上限；该值不是整台电脑或所有 worker 的共享预算。
- 新任务默认 DeepSeek deepseek-flash；Kimi 仍可显式选择，旧任务不自动切换。
- workspaceMode 支持 worktree（推荐）、branch（原目录新建分支）、current（使用当前分支）。直接修改主分支前，主控展示警告并把文字记入 mainBranchWarning，不额外索要批准。原目录模式要求干净检出；同一目录同时只允许一个任务占用。

调整内存：在当前生效配置中设置 workerMemoryLimitMB（单位 MiB）并在无活动任务时重启 daemon。例如 3072 为每个 worker 默认 3 GiB。运行工件 .runtime/workers/<task-id>/memory-*.json 记录限额、峰值、PID 和退出原因；该 Job 限制的是提交内存，不等同于任务管理器 RSS 或整机内存。Windows 以外目前拒绝不带 guard 的启动。

## 架构与行为

```text
Claude / GPT 主控（原订阅）
  └─ 显式启用的 Skill + MCP stdio
      └─ 本地常驻调度 daemon（仅 127.0.0.1，随机令牌）
          ├─ 任务记录、报告、验证日志
          └─ 每次任务运行的 OpenCode server（独立 API 环境）
              └─ Kimi / DeepSeek 官方 API
```

执行请求使用 OpenCode `/session/:id/prompt_async` 异步提交，之后以有界短请求轮询会话状态和消息，避免单次 HTTP 请求等待整轮执行。总任务时限仍然生效，取消会中断轮询并停止进程。轮询的短暂失败最多重试三次，不重复提交执行请求。最终结果必须属于本轮消息且会话已空闲，仍经严格报告校验。失败时保留运行编号、底层网络错误和最近消息快照。

恢复持久会话前会检查空 assistant 消息（包括中断后仅剩 step-start/reasoning 的消息及空 APIError 记录）。修复只在会话空闲时进行：先归档完整原历史，再通过 OpenCode 单条消息 DELETE 接口精确删除，最后核对其余消息完全一致；归档或校验失败则停止，不发送模型请求。有效文本、工具调用及工具错误记录保留；不会使用可能回滚工作区文件的 revert。原始数据库维护备份位于 .runtime/session-backups，逐次修复归档位于相应 worker 目录的 history-repair-*.json。

调度服务是确定性的程序，没有额外规划模型。主控决定任务目标、计划、依赖、返工内容与验收；执行模型处理详细代码调查和实现。后台保存完整记录，主控默认只收到有长度限制的摘要。任务与执行会话的对应关系会持久化，返工继续原 OpenCode 会话。

executor / investigator 的提示词要求先读取任务仓库根目录的 `CLAUDE.md`，再读取其中链接或 `@` 引用的本地规则文件（如 `AGENTS.md`）；根目录没有 `CLAUDE.md` 时回退到 `AGENTS.md`。处理模块前也需读取适用的目录/模块 `CLAUDE.md` 和 `AGENTS.md`，恢复会话时重新读取。这是 worker 的显式阅读要求，不是程序强制注入或读取校验；仍保持 Claude Code 自动集成禁用，不加载主控的个人技能或配置。提示词在每次派发时读取，修改对下一次启动/恢复的 worker 生效，正在运行的轮次不受影响。

状态：`planned → ready → running → awaiting_review → verifying → awaiting_review → accepted`。主控可以反复审查、验证和返工，直到满足验收条件；正常返工和 needs_replan 后的计划修订不限制轮数。默认最多同时执行 2 个任务，每轮最长 90 分钟。maxAttempts 默认 5，仅限制每个任务从 failed/interrupted/blocked 恢复的累计派发次数，首次执行和正常返工不占额度；恢复需要本轮结构化诊断反馈。修改计划、正常完成或重启 daemon 均不重置已用恢复额度，达到上限后由主控诊断或接管局部修复，不重建相同任务绕过限制。经审计确认的工作流基础设施故障可由维护者记录 infrastructureRetryCredits，增加恢复额度；历史 attempts/runId 不回退，worker 无权授予额度。workflow_status 分别显示总执行轮次 attempts、recoveryAttempts、recoveryAttemptLimit 和 remainingRecoveryAttempts，reworkLimit=null 表示正常返工不限轮数。旧任务没有恢复计数时从 0 开始记录，保留既有执行历史。

v0.2 增加 blocked / needs_replan。后者必须先经主控 workflow_plan_update 才能继续。计划版本 planRevision 与状态版本 revision 独立；每次执行另有唯一 runId，结果必须对应 taskId、planRevision、runId、attempt。计划更新使旧报告、反馈和检查失效，但不清空总尝试次数。

内置 build/plan/general/explore/scout 已禁用，执行请求只指定 executor 或 investigator，task/plan 工具禁用；拒绝恢复含内置 Plan 历史的会话。自定义角色允许局部实现与调试，不允许擅改固定设计。任务以 JSON 契约交接，结果是应用层严格 JSON Schema 校验的报告。OpenCode 1.19.3 原生 json_schema format 在本地测试中导致持久会话读取报 OutputFormatJsonSchema 错误，所以采用普通消息承载 JSON，由应用校验，不使用该原生格式。普通文本、缺字段、错误版本和不完整的完成声明均不能进入待验收。

`prepare`、`dispatch`、`verify` 在 executionEnabled=false 时都会拒绝执行。任务创建读取本地 Git 身份和 profile，记录解析后的计划，不修改仓库文件或调用模型。profile 绑定 Git common directory，worktree 共用偏好；任务快照保留 profile 版本/哈希及字段来源。执行 agent 的“完成”只能进入待验收。`verify` 在模型外真实运行主控选择的命令，记录理由、遗漏范围、退出码和日志；默认验收要求所选检查在当前源码全部通过。`review_allowed` 合同还允许明确选择仅代码审查，记录源码指纹、理由、证据和遗漏范围。主控须实际读代码检查功能覆盖，服务器无法替模型证明语义正确。详见[仓库偏好](repository-preferences.md)。

MCP 客户端关闭不停止 daemon，所以已派发任务可继续。主控关闭后不会自动产生下一轮规划或验收。daemon 意外终止时，IPC 监护进程负责停止 OpenCode；下次启动把未完成任务标为 interrupted，不自动重放。

## 关键文件

| 文件 | 内容 |
|---|---|
| [公共 Skill](../../skills/orchestrate-code/SKILL.md) | 主控规划、委派、返工与验收 |
| [配置](../../workflow.config.json) | 执行开关、限额与供应商 |
| [调度引擎](../../src/engine.ts) | 状态、依赖、独立验证与验收 |
| [Worker](../../src/opencode.ts) | OpenCode 进程、凭据与会话 |
| [MCP 工具](../../src/tools.ts) | 主控调用入口 |
| [角色提示词](../../prompts/) | 实现与调查的自治和升级边界 |
| [协议校验](../../src/protocol.ts)、[Schema](../../src/schema.ts) | 契约、报告与反馈 |
| [内存监护](../../src/memory-guard.ts) | Windows Job Object 监督 |

## v0.2 的实际边界

- OpenCode 的工具权限、分支与 worktree 不是 OS 沙箱。实现 agent 有广泛 shell 权限以运行项目工具链；禁止 push 等规则和 allowedPaths 检查不能保证任意 shell 代码无法绕过。它适用于你信任的本地仓库。
- 只读 investigator 禁止写文件和通用 shell，只开放文件读取与少量 Git 查询；更复杂的只读检查由主控完成。
- prerequisites/dependencies 是调度和基线检查，不会自动合并源码。依赖结果必须在所选基线中；跨任务整合与组合测试由主控完成。
- evidence 是主控填写的引用；服务器检查运行证据与源码版本，不能判断主控有没有认真审查。报告的 token/cost 是 OpenCode 返回值，custom provider 的 cost 可能为 0，不是供应商账单。
- 任务正文、仓库规则、构建命令和 AGENTS.md 属于受信任的任务输入。执行端不会自动继承主控的客户端插件、浏览器工具或订阅额度。

密钥只从本地文件或环境读入，不写进 MCP 配置。worker 环境会剔除继承的主控 API/OAuth/GitHub 凭据，只注入所选供应商的 Key，并使用独立 XDG 配置和数据目录。日志做尽力脱敏，不等同于完整秘密检测。
