# 任务交接协议 v1（实现 v0.2）

[English](../en/protocol.md) | [文档目录](README.md)

v0.1 的自由文本 acceptance/feedback 输入需升级成这里的带 ID、带版本结构；不自动猜测或转换历史已执行任务。已存任务保留原执行身份，新字段兼容缺省值。

Claude/GPT 主控决定计划；MCP 提交 JSON，Zod 校验后存储；程序将完整任务契约 JSON 作为 OpenCode 用户消息，独立 agent prompt 提供角色职责。没有额外规划模型，也不转发整段主控聊天。执行者允许局部实现/调试决策，改变固定设计、范围或接口约束必须升级。

## 输入

TaskSpec：contractVersion=1，planRevision 从 1 开始；id、repository、baseRef、branch、provider、mode、workspaceMode、dependencies 是执行身份字段。goal/nonGoals、decisions（含理由）、contextRefs、steps（前序依赖、fixed/adaptable）、autonomy、带稳定 ID 的 acceptance、constraints、allowedPaths 以及两组测试 workerChecks / checks 是工作约定。完整实例见 [examples/alpha-244.json](../../examples/alpha-244.json)；最终 Schema 以 [src/schema.ts](../../src/schema.ts) 为准。

创建输入可少于完整 TaskSpec，只必填 `id`、`repository`、`goal` 和 `acceptance`。服务端读取仓库本地 profile，合并任务覆盖与内置默认值，保存完整合同及含 profile 内容/版本/哈希和来源的 `configuration-vN.json`。通过 `workflow_repository_config` 读取偏好，`workflow_repository_config_update` 明确修改，详见[仓库偏好](repository-preferences.md)。

每次 dispatch 都生成 runId，加入 attempt 和程序解析出的 workspace.path/worktree/mode/baseCommit，写入 contract.json 及不会被覆盖的 contract-run-UUID.json。它是执行者本轮接到的契约。状态变化使用 revision，计划变化使用 planRevision；两者不能互换。

TaskSpec 的 workerChecks 是 worker 增量命令；checks 是主控计划中的独立验证命令。实际执行契约将 checks 投影为 workerChecks，只向 worker 提供计划检查名称和待验收标记。旧任务缺少 workerChecks 时，worker 自选有界增量检查并将命令结果写入验收证据，不执行旧计划中的全量步骤。pending_supervisor 需要主控检查配置或 `review_allowed` 策略支持；它不表示检查已通过，最终须由主控选择验证或明确代码审查并提供证据。

provider 缺省为 deepseek。workspaceMode 缺省为推荐的 worktree，也可 branch/current；主分支 current 需先展示并记录 mainBranchWarning。原目录模式要求干净检出并持有任务级目录占用，工作区分支和源码指纹保护与 worktree 相同。

workflow_verify 可传 selection={strategy,rationale,checks,omittedCoverage}，策略包括 planned/targeted/affected/smoke/full/custom。未传时运行当前计划中的 checks；传入时仅执行本轮所选命令，选择记录不修改 TaskSpec 或 planRevision。默认 `verificationPolicy=commands_required` 要求独立命令在当前源码通过；`review_allowed` 允许主控明确选择仅代码审查，记录理由、证据、源码指纹及非空遗漏范围，不伪造检查通过。完整测试只在主控判断需要或当前用户明确要求时运行。

workerMemoryLimitMB 是全局配置中的每 worker 提交内存上限，缺省 3072 MiB。Windows Job Object 在 OpenCode 恢复执行前绑定，普通子进程继承限制；内存/守护错误记录到 worker 工件和失败诊断。任务恢复沿用原会话与源码，不自动提高限额。

## 等待、验证轮次与主控证据

`workflow_wait` 仍是最多 25 秒的 revision 等待，由任务保存事件唤醒；客户端断开只取消该次读取。`node dist/src/cli.js wait <id>` 在单个 CLI 进程中衔接短等待，`--until change`、可重复的 `--after <id>=<revision>`、`--timeout-ms` 分别指定 revision 等待、重连游标和总时限。默认在任一任务需要主控介入时返回，不必等到 `accepted`。输出为 `{reason,tasks}`；总超时返回最后已知快照并以 2 退出，Ctrl+C 以 130 退出，不取消任务。

每轮验证生成 `verificationRunId`、`verification-UUID.json` 和独立的 `verify-UUID-<check>.log`。`verificationHistory` 保存轮次索引；工件记录选择、计划/worker 运行身份、源码指纹、结果和最终状态（`passed`、`failed`、`stopped`、`cancelled` 或 `interrupted`）。重新验证、返工、计划修订均保留历史。清空旧格式检查结果前会归档其结果和日志；旧记录缺少可靠开始时间，归档时以记录中的完成时间代替开始时间。

`workflow_verify_stop {id,reason}` 只中止验证，等待进程树退出后回到 `awaiting_review`。已完成检查保留；中断中的命令记录 `status=stopped`、`passed=false`、`exitCode=null`，不再启动后续检查。未完成源码一致性验证的轮次不能用于通过验收。停止与完成竞态时保留已完成结果，重复停止该轮无副作用。取消整个任务仍是终态。

`workflow_evidence_add {id,entry}` 追加主控证据。`entry` 包含当前 `planRevision`、`kind=integration|verification|note`、摘要、非空验收项 ID 与证据引用，以及可选日志（最多 200,000 字符）。服务端记录独立工件、当前源码指纹、worker 运行身份及时间，并脱敏已配置密钥。未知验收项、旧计划版本、执行中的任务均拒绝记录。取消任务后允许追加，但不重新打开任务，也不授予独立验证通过状态。通过 `supervisorEvidence` 索引及 `workflow_artifact` 读取。

## 输出

执行者最终只返回一个 JSON 对象，严格匹配 WorkerReportSchema；不接受 Markdown 包裹、普通文本或从散乱报告猜测状态。报告包括 taskId/planRevision/runId/attempt、summary、acceptanceResults、checks、changedFiles、deviations 和 blockers。

- ready_for_review：每个验收 ID 出现一次，实施完成项标 met，等待主控选定验证的项标 pending_supervisor，两者均需证据；每个 workerChecks 出现一次并报 passed，且无实施 blocker。进入 awaiting_review，不是 accepted。
- blocked：环境/访问/依赖问题，提供证据与下一步建议。原计划可在主控提供结构化诊断反馈后重试。
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

## 修改计划

workflow_plan_update 接收 id、expectedPlanRevision、局部 spec 或完整新 spec，以及 changeReason。省略 planRevision 时自动 +1，显式传入也须恰好 +1。默认沿用任务冻结的 profile，只有 `refreshRepositoryProfile=true` 才采用当前偏好。不能在运行中/验证中/已验收/已取消时更新，不能改变执行身份。程序归档旧计划、清除旧反馈/报告/检查/验证指纹，保留工作树、执行会话、既有修改和尝试次数。下一次派发的最新契约覆盖旧消息的任务指令；有用的代码调查结果仍可复用。

如果要改变基线、仓库或模型，建立不同任务并明确迁移，而不是把已有证据悄悄算到另一套执行身份上。attempts 保留所有派发的单调轮次；正常审查返工不设轮数上限。maxAttempts 默认 5，仅约束 failed/interrupted/blocked 后的累计恢复派发次数 recoveryAttempts，首次执行不计入。异常状态修改计划后仍需诊断反馈并消耗恢复额度；计划更新、正常完成和 daemon 重启均不重置该额度。达到恢复上限仍由主控诊断，不借改计划或重建相同任务绕过预算。

## OpenCode 兼容处理

本机固定 1.19.3 的原生 format=json_schema 试验能产生 structured 结果，但后续 GET session messages 出现 OutputFormatJsonSchema 编码错误，影响恢复。v0.2 使用普通消息承载严格 JSON，应用进行完整 Schema 与语义一致性校验；不依赖该原生功能，也不修改 OpenCode 二进制。角色系统提示词与 JSON 输出要求都在真实 localhost 模拟测试中检查；真实模型是否遵守设计边界仍需首轮业务验收。
