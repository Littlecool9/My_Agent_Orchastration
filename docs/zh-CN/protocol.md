# 任务交接协议 v1（实现 v0.2）

[English](../en/protocol.md) | [文档目录](README.md)

v0.1 的自由文本 acceptance/feedback 输入需升级成这里的带 ID、带版本结构；不自动猜测或转换历史已执行任务。已存任务保留原执行身份，新字段兼容缺省值。

Claude/GPT 主控决定计划；MCP 提交 JSON，Zod 校验后存储；程序将完整任务契约 JSON 作为 OpenCode 用户消息，独立 agent prompt 提供角色职责。没有额外规划模型，也不转发整段主控聊天。执行者允许局部实现/调试决策，改变固定设计、范围或接口约束必须升级。

## 输入

TaskSpec：contractVersion=1，planRevision 从 1 开始；id、repository、baseRef、branch、provider、mode、workspaceMode、dependencies 是执行身份字段。goal/nonGoals、decisions（含理由）、contextRefs、steps（前序依赖、fixed/adaptable）、autonomy、带稳定 ID 的 acceptance、constraints、allowedPaths 以及两组测试 workerChecks / checks 是工作约定。项目专用实例存放在各自的本地 repo profile；最终 Schema 以 [src/schema.ts](../../src/schema.ts) 为准。

allowedPaths 的每一项是仓库相对的字面文件或目录前缀；通配符、绝对路径和反斜杠在合同创建或修改时即被拒绝。resources 包含运行时限、内存上限、模型步数预算（workerSteps）和可选的累计 tokenBudget。environment 为 worker 和验证命令增加非机密环境变量；看起来像凭据的名字会被拒绝。本页各机制的确切规则见[主控参考](supervisor-reference.md)。

创建输入可少于完整 TaskSpec，只必填 `id`、`repository`、`goal` 和 `acceptance`。仓库本地 profile 缺失时，服务端先最小初始化且不保存本次任务选择，再合并任务覆盖与内置默认值，保存完整合同及含 profile 内容/版本/哈希和来源的 `configuration-vN.json`。`workflow_repository_init {repository}` 也提供直接的幂等初始化；`workflow_repository_config` 保持只读，`workflow_repository_config_update` 明确修改偏好，详见[仓库偏好](repository-preferences.md)。

每次 dispatch 都生成 runId，加入 attempt 和程序解析出的 workspace.path/worktree/mode/baseCommit，写入 contract.json 及不会被覆盖的 contract-run-UUID.json。它是执行者本轮接到的契约。状态变化使用 revision，计划变化使用 planRevision；两者不能互换。

TaskSpec 的 workerChecks 是 worker 增量命令；checks 是主控计划中的独立验证命令。实际执行契约将 checks 投影为 workerChecks，只向 worker 提供计划检查名称和待验收标记。旧任务缺少 workerChecks 时，worker 自选有界增量检查并将命令结果写入验收证据，不执行旧计划中的全量步骤。pending_supervisor 需要主控检查配置或 `review_allowed` 策略支持；它不表示检查已通过，最终须由主控选择验证或明确代码审查并提供证据。

provider 缺省为 deepseek。workspaceMode 缺省为推荐的 worktree，也可 branch/current；主分支 current 需先展示并记录 mainBranchWarning。原目录模式要求干净检出并持有任务级目录占用，工作区分支和源码指纹保护与 worktree 相同。

workflow_verify 可传 selection={strategy,rationale,checks,omittedCoverage}，策略包括 planned/targeted/affected/smoke/full/custom。未传时运行当前计划中的 checks；传入时仅执行本轮所选命令，选择记录不修改 TaskSpec 或 planRevision。默认 `verificationPolicy=commands_required` 要求独立命令在当前源码通过；`review_allowed` 允许主控明确选择仅代码审查，记录理由、证据、源码指纹及非空遗漏范围，不伪造检查通过。完整测试只在主控判断需要或当前用户明确要求时运行。一轮验证遇到第一个失败的检查就停，除非传 `continueOnFailure=true`。`rerun=failed` 沿用上一轮的选择，只执行未通过的检查，并把之前通过的结果带过来（标记 `reusedFrom`），前提是源码指纹、计划版本和 worker 运行都没变。失败结果附带输出末尾（`tail`）和解码后的异常退出码（`exitDetail`）。

workerMemoryLimitMB 是全局配置中的每 worker 提交内存上限，缺省 3072 MiB。Windows Job Object 在 OpenCode 恢复执行前绑定，普通子进程继承限制；内存/守护错误记录到 worker 工件和失败诊断。任务恢复沿用原会话与源码，不自动提高限额。

## 等待、验证轮次与主控证据

`workflow_wait` 仍是最多 25 秒的 revision 等待，由任务保存事件唤醒；客户端断开只取消该次读取。`node dist/src/cli.js wait <id>` 在单个 CLI 进程中衔接短等待，`--until change`、可重复的 `--after <id>=<revision>`、`--timeout-ms` 分别指定 revision 等待、重连游标和总时限。默认在任一任务需要主控介入时返回，不必等到 `accepted`。等待开始时已经 accepted、integrated 或 cancelled 的任务会被忽略（除非所列任务全是终态）；显式的 `--after` 游标表示该任务到这个 revision 为止已经看过。因此同一份 ID 列表可以反复使用，即使其中有任务已完成或正在审查。输出为 `{reason,tasks,attention}`，`attention` 列出触发返回的任务；总超时返回最后已知快照并以 2 退出，Ctrl+C 以 130 退出，不取消任务。运行中的实时进度不算 revision 变化，不会结束等待。

每轮验证生成 `verificationRunId`、`verification-UUID.json` 和独立的 `verify-UUID-<check>.log`。`verificationHistory` 保存轮次索引；工件记录选择、计划/worker 运行身份、源码指纹、结果和最终状态（`passed`、`failed`、`stopped`、`cancelled` 或 `interrupted`）。重新验证、返工、计划修订均保留历史。清空旧格式检查结果前会归档其结果和日志；旧记录缺少可靠开始时间，归档时以记录中的完成时间代替开始时间。

`workflow_verify_stop {id,reason}` 只中止验证，等待进程树退出后回到 `awaiting_review`。已完成检查保留；中断中的命令记录 `status=stopped`、`passed=false`、`exitCode=null`，不再启动后续检查。未完成源码一致性验证的轮次不能用于通过验收。停止与完成竞态时保留已完成结果，重复停止该轮无副作用。取消整个任务仍是终态。

`workflow_evidence_add {id,entry}` 追加主控证据。`entry` 包含当前 `planRevision`、`kind=integration|verification|note`、摘要、非空验收项 ID 与证据引用，以及可选日志（最多 200,000 字符）。服务端记录独立工件、当前源码指纹、worker 运行身份及时间，并脱敏已配置密钥。未知验收项、旧计划版本、执行中的任务均拒绝记录。取消任务后允许追加，但不重新打开任务，也不授予独立验证通过状态。通过 `supervisorEvidence` 索引及 `workflow_artifact` 读取。

终态 `integrated` 用于补记历史任务已经集成的交付事实：源提交已包含在后续任务的基线中。`integration` 字段与独立工件保留原状态、源/目标提交、原因及证据。它不补造验收记录、通过的检查或源码验证指纹，也不满足依赖调度所需的 `accepted` 条件。普通任务工具不能重新打开或取消它。

## 输出

执行者最终只返回一个 JSON 对象，严格匹配 WorkerReportSchema。任务消息里提供 `REPORT_TEMPLATE`，即已填好运行身份、验收项 ID 和 worker 检查名称的骨架。不涉及任何主张的格式缺陷会被规范化并记录，而不是拒绝：Markdown 代码块或前后文字、未知键、过长的 summary、缺失的空数组和检查列表的登记问题。程序不会猜测状态，也不会修正身份、验收项覆盖和证据要求。报告包括 taskId/planRevision/runId/attempt、summary、acceptanceResults、checks、changedFiles、deviations 和 blockers。

- ready_for_review：每个验收 ID 出现一次，实施完成项标 met，等待主控选定验证的项标 pending_supervisor，两者均需证据；每个 workerChecks 出现一次并报 passed，且无实施 blocker。进入 awaiting_review，不是 accepted。
- blocked：环境/访问/依赖问题，提供证据与下一步建议。原计划可在主控提供结构化诊断反馈后重试。如果这一轮用完了全部步数预算，任务会标记 `continuation.reason=step_limit`，直接再次派发即可。
- needs_replan：任务契约/设计冲突或需要改变范围，提供证据与变更建议。必须由主控更新计划，不能直接重派旧计划。

程序再次校验运行身份、覆盖完整性、证据存在和状态一致性。它不能验证自然语言证据是否真实；verify 真实执行检查，主控实际读代码审查。report.json 为校验通过的本轮报告；raw-report-attempt-N.json 保留原始结果，worker-report.md 是程序渲染的中文摘要，transcript.json 保存执行记录。

## 返工

workflow_review decision=rework 必须同时传反馈：

```json
{
  "planRevision": 1,
  "summary": "补齐分配器边界验证",
  "findings": [
    {
      "criterionIds": ["AC-02"],
      "description": "节点 ID 到上限时会回绕",
      "evidence": ["具体源码位置", "失败用例或日志"],
      "requestedChange": "拒绝溢出分配，并加入回归测试"
    }
  ]
}
```

反馈版本必须是当前版本，引用的 ID 必须存在。failed/interrupted/blocked 的诊断重派也使用这个结构。它引用当前计划，不自动构成改计划。

有两种结束方式不需要主控写反馈，也不消耗恢复额度。因步数预算用尽而 `blocked` 的运行，可以在原会话里继续，连续最多 `maxStepContinuations`（默认 2）次；下一份契约带有 `continuation` 对象。补交后报告仍然无效的运行会变成 `needs_changes`，并附带系统写的反馈（列出校验错误），下一次派发按普通返工处理。

## 排队派发与运行进度

所有 worker 槽位都被占用时，`workflow_dispatch {id,queue:true}` 把任务置为 `queued`，有槽位空出时按入队先后启动。`workflow_cancel {id,scope:"queue"}` 撤回排队。队列只在内存里：daemon 重启会撤回排队中的派发，不启动任何东西，并写上 `queueError`。

任务运行期间，`workflow_status {id}.run` 给出已用时间、模型步数与预算、上报的 token、最近一次工具调用和空闲秒数。这个视图不落盘，也不改变 `revision`。`lastRun` 保留已结束运行的耗时、步数和 token。

## 修改计划

workflow_plan_update 接收 id、expectedPlanRevision、局部 spec 或完整新 spec，以及 changeReason。省略 planRevision 时自动 +1，显式传入也须恰好 +1。默认沿用任务冻结的 profile，只有 `refreshRepositoryProfile=true` 才采用当前偏好。不能在运行中/验证中/排队中/已验收/已取消时更新，不能改变执行身份。程序归档旧计划、清除旧反馈/报告/检查/验证指纹，保留工作树、执行会话、既有修改和尝试次数。下一次派发的最新契约覆盖旧消息的任务指令；有用的代码调查结果仍可复用。

`workflow_plan_amend {id,expectedPlanRevision,patch,reason}` 只修改主控一侧的字段：`checks`、`allowedPaths` 和 `resources`。计划版本、worker 报告、反馈、证据和会话都保留，因为 worker 从不执行这些值。每次修订写入 `amendment-UUID.json`，含修改前后的值和原因，并在 status 和 handoff 中列出。如果上一轮通过的验证用的是计划内的检查，修改 `checks` 会使它失效。worker 要执行的字段（包括 `workerChecks`）仍需计划更新。

如果要改变基线、仓库或模型，建立不同任务并明确迁移，而不是把已有证据悄悄算到另一套执行身份上。attempts 保留所有派发的单调轮次；正常审查返工不设轮数上限。maxAttempts 默认 5，仅约束 failed/interrupted/blocked 后的累计恢复派发次数 recoveryAttempts，首次执行不计入。异常状态修改计划后仍需诊断反馈并消耗恢复额度；计划更新、正常完成和 daemon 重启均不重置该额度。达到恢复上限仍由主控诊断，不借改计划或重建相同任务绕过预算。

## 模型标签与并发容量

每个 provider 可配置可选的用户手工 `tags`（自由文本数组）。`workflow_config` 返回模型、标签及 Key 是否存在。主控按标签语义与任务需求选择，优先遵守用户显式选择和仓库 provider 偏好；标签是用户评价，不是内置排名，也不能授权修改凭据。带标签的模型选择必须提供任务级 `modelSelectionReason`。新任务在 `task.json.executionProvider` 冻结 provider 配置、模型和标签，只记录 Key 环境变量名称，不记录值。配置修改影响新任务；历史任务在下一次显式派发时冻结当时配置。计划修订保留快照，状态返回模型、标签、理由及 `modelConfigPinned`。

`workflow_capacity {}` 返回 daemon 共享的 `maxParallel`、运行 worker、空闲槽位、排队中的派发、各自内存上限、步数预算、独立验证任务，以及带 `idleDays` 的目录占用。它不测量实际内存。独立验证进程不受 worker 槽位和内存 Job 限制，仍可能竞争资源。branch/current 在接受或取消前占用同一目录，并行独立任务需不同目录。配置上限为 2 不等于功能只能支持 2，可配置范围为 1–8。构建并发、磁盘和缓存方案保留在目标仓库配置中。

## 持久监督日志与恢复摘要

`workflow_note_add {id,entry}` 记录不绑定源码的监督历史。entry 包含当前 `planRevision`、`kind=decision|repair|handoff|risk|next_step`、`summary`（最多 2,000 字符），可选 `detail`（20,000 字符）及 `relatedTaskIds`（最多 8 个已存在任务）。准备前、执行中、换分支后和终态都可追加。独立 `note-UUID.json` 工件含脱敏内容及时间，无源码指纹，不授予验证或验收通过。计划更新保留旧日志及其原版本。具体源码检查结果仍用 `workflow_evidence_add`。

`workflow_handoff {ids:[...]}` 返回 1–8 个任务的恢复/报告提纲：目标与决策、依赖状态、关联验收项的 worker 自述、近期审查、最近验证及报告提交、最近 5 条日志和 5 条证据引用。明确返回遗漏数量，旧内容仍可按工件读取。它不检查当前源码、不重新验证旧证据、不自动合并分支栈，也不调度 milestone。及时记录重要修复和决策，换用共享目录前写下一步；上下文压缩后和最终报告前读取摘要，分别列明 worker 自测、独立验证和监督方陈述。

## 一次自动补交报告

模型完成一轮并经过格式规范化之后，报告仍然找不到 JSON 对象、不符合 Schema 或违反语义契约规则时，最多自动补交一次。在原 session/task/plan/run/attempt 中，把具体错误与当前契约交给工具全部禁用的 reporter；不能重新实现、执行检查或补造证据。补交仍经过相同运行身份、验收项与检查覆盖校验，不会自动接受任务。已知失败与证据不足必须如实保留。

补交共享原任务截止时间，另有 120 秒上限；它本身不算一次恢复派发，也不重置预算。`reportSubmissions` 与 `report-submission-<runId>.json` 记录提交次数、状态、原始及补交校验错误、补交耗时、累计和补交独有 token/费用，失败补交同样记账。初次及补交响应保留在 `.runtime/workers/<id>/`。费用是供应商报告值，不是账单。取消、内存/进程终止、provider 错误及超时不走格式重试。补交后的报告仍然无效时，任务变为 `needs_changes`，带系统写的反馈和 `continuation.reason=report_invalid`；工作区完好，下一次派发按普通返工处理。补交过程中的传输或进程故障仍算一次 `failed` 运行。补交期间仍为 `running`，主控不要另行重派。

## OpenCode 兼容处理

本机固定 1.19.3 的原生 format=json_schema 试验能产生 structured 结果，但后续 GET session messages 出现 OutputFormatJsonSchema 编码错误，影响恢复。v0.2 使用普通消息承载严格 JSON，应用进行完整 Schema 与语义一致性校验；不依赖该原生功能，也不修改 OpenCode 二进制。角色系统提示词与 JSON 输出要求都在真实 localhost 模拟测试中检查；真实模型是否遵守设计边界仍需首轮业务验收。
