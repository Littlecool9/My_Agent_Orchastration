# 任务交接协议 v1（实现 v0.2）

v0.1 的自由文本 acceptance/feedback 输入需升级成这里的带 ID、带版本结构；不自动猜测或转换历史已执行任务。本次交付尚未创建 #244 任务。

Claude/GPT 主控决定计划；MCP 提交 JSON，Zod 校验后存储；程序将完整任务契约 JSON 作为 OpenCode 用户消息，独立 agent prompt 提供角色职责。没有额外规划模型，也不转发整段主控聊天。执行者允许局部实现/调试决策，改变固定设计、范围或接口约束必须升级。

## 输入

TaskSpec：contractVersion=1，planRevision 从 1 开始；id、repository、baseRef、branch、provider、mode、dependencies 是执行身份字段。goal/nonGoals、decisions（含理由）、contextRefs、steps（前序依赖、fixed/adaptable）、autonomy、带稳定 ID 的 acceptance、constraints、allowedPaths 和 checks 是工作约定。完整实例见 examples/alpha-244.json；最终 Schema 以 src/schema.ts 为准。

每次 dispatch 都生成 runId，加入 attempt 和程序解析出的 workspace.worktree/baseCommit，写入 contract.json 及不会被覆盖的 contract-run-UUID.json。它是执行者本轮接到的契约。状态变化使用 revision，计划变化使用 planRevision；两者不能互换。

## 输出

执行者最终只返回一个 JSON 对象，严格匹配 WorkerReportSchema；不接受 Markdown 包裹、普通文本或从散乱报告猜测状态。报告包括 taskId/planRevision/runId/attempt、summary、acceptanceResults、checks、changedFiles、deviations 和 blockers。

- ready_for_review：每个验收 ID 出现一次并标 met，有证据；每个配置检查出现一次并报 passed，且无 blocker。进入 awaiting_review，不是 accepted。
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

workflow_plan_update 接收 id、expectedPlanRevision、完整新 spec 和 changeReason。新版本必须恰好 +1；不能在运行中/验证中/已验收/已取消时更新，不能改变执行身份。程序归档旧计划、清除旧反馈/报告/检查/验证指纹，保留工作树、执行会话、既有修改和尝试次数。下一次派发的最新契约覆盖旧消息的任务指令；有用的代码调查结果仍可复用。

如果要改变基线、仓库或模型，建立不同任务并明确迁移，而不是把已有证据悄悄算到另一套执行身份上。达到尝试上限仍由主控诊断，不借改计划重置预算。

## OpenCode 兼容处理

本机固定 1.19.3 的原生 format=json_schema 试验能产生 structured 结果，但后续 GET session messages 出现 OutputFormatJsonSchema 编码错误，影响恢复。v0.2 使用普通消息承载严格 JSON，应用进行完整 Schema 与语义一致性校验；不依赖该原生功能，也不修改 OpenCode 二进制。角色系统提示词与 JSON 输出要求都在真实 localhost 模拟测试中检查；真实模型是否遵守设计边界仍需首轮业务验收。
