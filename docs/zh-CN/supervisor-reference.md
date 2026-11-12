# 主控参考

[English](../en/supervisor-reference.md) | **简体中文** | [文档目录](README.md)

[主控 Skill](../../skills/orchestrate-code/SKILL.md) 讲主路径。本页放 主控 不常用到的细节：每个机制的确切规则、边界情况，以及为旧任务保留的行为。以 [src/schema.ts](../../src/schema.ts) 和 [src/tools.ts](../../src/tools.ts) 为准。

## 契约解析

`workflow_task_create` 只需要 `id`、`repository`、`goal` 和 `acceptance`。省略的字段按这个顺序解析：内置默认值、仓库 `defaults`、任务输入。内置值为 `contractVersion=1`、`planRevision=1`、`baseRef=HEAD`、分支 `codex/<id>`（或 profile 的 `branchPrefix`）、provider `deepseek`、`workspaceMode=worktree`、一个 adaptable 步骤，以及 `verificationPolicy=commands_required`。

- 任务提供的数组和标量会替换默认值，显式的空数组也算。
- `resources` 和 `environment` 按字段名合并。
- 仓库的 `requirements.constraints` 总会追加，被要求的验证策略不能放宽。
- check 的 command 或 args 里的 `profile://scripts/<file>`，在契约创建、更新或修订时解析为所绑定 profile 目录内的现有文件。命令在任务工作区执行，脚本本身不会复制进任务。

服务端保存完整解析后的 spec 和 `configuration-v<planRevision>.json`，其中有 profile 的 revision/hash、任务自己的覆盖项，以及每个字段的来源。需要完整约定时读这个 artifact。没有 profile 时自动创建，已有的原样复用。

## 范围

`allowedPaths` 的每一项是仓库相对的字面路径：一个文件，或一个目录前缀（末尾斜杠可有可无）。只要某一项含有 `*` 或 `?`、反斜杠、盘符或前导斜杠、空路径段、`.`/`..` 路径段，契约在创建、计划更新和修订时就会被拒绝。方括号和花括号是普通字符，例如 `app/[id]/page.tsx`。

范围检查发生三次：worker 运行结束时（结果写入状态里的 `scopeViolations`，仅提示）、验证前、验收前（后两次会拒绝）。未跟踪文件也算。`allowedPaths` 是评审手段，不是沙箱。

## 资源

| 字段 | 默认值 | 上限 | 作用 |
|---|---|---|---|
| `taskTimeoutMinutes` | 有效上限 | 机器 `taskTimeoutMinutes`、仓库 `limits` | 整个 worker 运行，含报告重交。 |
| `workerMemoryLimitMB` | 有效上限 | 机器 `workerMemoryLimitMB`、仓库 `limits` | worker 进程树的已提交内存。 |
| `workerSteps` | 机器 `workerSteps`（150） | 机器 `maxWorkerSteps`（600）、仓库 `limits` | 单次运行的模型步数。 |
| `tokenBudget` | 仓库 `limits.tokenBudget`，否则无 | 仓库 `limits.tokenBudget` | 任务累计上报的 token。 |

任务在创建时固定解析后的值。之后用 `workflow_plan_amend` 修改，从下一次派发起生效。

**token 预算。** 任务已达预算时，派发会被拒绝。运行中一旦上报用量超过预算，worker 被停止，任务变为 `failed`，`lastError` 里是 `WORKER_TOKEN_BUDGET`，工作区保留；调高预算后恢复属于普通的恢复派发。token 数是 provider 上报的 input、output 和 reasoning；缓存读取不计入预算。

**成本。** `costReported` 累加 provider 自己上报的成本。自定义端点通常上报 0；如果 provider 配置里有 `pricing`（`currency`、`inputPerMillion`、`outputPerMillion`、可选的 `cacheReadPerMillion`），就改用上报的 token 估算，缓存读取按 `cacheReadPerMillion` 计价，没配则按 input 单价。pricing 随 provider 在任务创建时一起固定。这是按标价的估算，不是账单。运行失败前花掉的 token 仍会计入任务合计。

## 环境变量

`environment` 是变量名到值的映射，会加到 worker 进程和验证命令的环境里。`${NAME}` 从当前已构建的环境展开，所以 `"PATH": "D:/tools/bin;${PATH}"` 是前置追加。Windows 上变量名不区分大小写，契约里的写法会替换继承来的那个。最多 64 个变量。

名字包含 `KEY`、`TOKEN`、`SECRET`、`PASSWORD`、`CREDENTIAL`，或以 `OPENAI`、`ANTHROPIC`、`CLAUDE`、`CODEX`、`GH_`、`GITHUB_`、`OPENCODE_`、`XDG_` 开头的会被拒绝：这些正是从 worker 环境里剥掉的名字，而且契约内容会存进任务记录并展示给 worker。worker 自己的控制变量始终优先。

仓库的工具链变量放进 profile 的 `defaults.environment`，任务会自动继承。目前没有工作区 setup 命令：新建的 worktree 里没有已安装的依赖和构建目录，除非 worker 或仓库自己的脚本去创建。

## 派发、排队与容量

`maxParallel` 统计所有仓库正在运行的 worker。达到上限时派发会失败，除非传 `queue:true`。排队中的任务状态是 `queued`；`workflow_status {id}.queued` 显示它的位置，以及撤回后会回到的状态。

- 前置条件（密钥存在、依赖已验收、工作区完好、预算）在入队时检查一次，启动时再检查一次。恢复次数在启动时才计，不在入队时计。
- 有空槽时，按入队先后依次启动。
- `workflow_cancel {id,scope:"queue"}` 撤回派发并恢复之前的状态。排队期间不能做计划更新。
- 排队的派发启动失败时，任务回到之前的状态并带上 `queueError`；等待 CLI 把它当作需要关注。
- 队列在 daemon 的内存里。daemon 停止或重启会撤回所有排队的派发、写上 `queueError`，不会启动任何东西。

验证不排队，也不占 worker 槽。

## 运行进度

任务处于 `running` 时，`workflow_status {id}.run` 包含：

| 字段 | 含义 |
|---|---|
| `startedAt`、`elapsedSeconds`、`timeoutMinutes` | 已用时间与运行时限。 |
| `phase` | `starting`、`working` 或 `report_repair`。 |
| `steps`、`stepLimit` | 本次运行已用的模型步数和预算。 |
| `tokens` | 本次运行到目前上报的 token。 |
| `lastTool` | 最近一次工具调用：名称、状态和标题（shell 命令的标题就是命令本身）。 |
| `lastActivityAt`、`idleSeconds` | transcript 上次变化的时间。长时间构建表现为工具在运行、但空闲时间增长。 |

进度每秒从 worker 读一次，只放在内存里。它不改变任务的 `revision`，所以 `workflow_wait` 和等待 CLI 不会因它返回。运行结束后，`lastRun` 保留 run ID、时间戳、耗时、结果、步数和 token。

## 运行如何结束

| 结果 | 状态 | 是否消耗恢复次数 | 恢复是否需要反馈 |
|---|---|---|---|
| 合格的 `ready_for_review` 报告 | `awaiting_review` | – | – |
| 合格的 `needs_replan` 报告 | `needs_replan` | 否 | 先做计划更新 |
| 合格的 `blocked` 报告，步数未到预算 | `blocked` | 是 | 是 |
| 合格的 `blocked` 报告，步数预算用尽 | `blocked`，`continuation.reason=step_limit` | 否，连续最多 `maxStepContinuations` 次 | 否 |
| 报告重交一次后仍无效 | `needs_changes`，`continuation.reason=report_invalid` | 否 | 否（已附系统写的反馈） |
| provider 错误、超时、内存超限、token 预算、进程退出 | `failed` | 是 | 是 |
| 运行期间 daemon 停止 | `interrupted` | 是 | 是 |

**步数用尽后的续跑。** 一次运行用掉的模型步数等于预算，就算到了步数上限。worker 的最后一步没有工具，只能报告还剩什么。再次派发这种任务会在同一个会话和工作区里继续：新契约带有 `continuation` 对象，告诉 worker 不要重做已完成的工作。前 `maxStepContinuations`（默认 2）次连续续跑不需要反馈，也不算恢复；一旦某次运行到达 `awaiting_review`，计数清零。超过次数或做过计划更新之后，按普通恢复规则处理。反复步数用尽说明任务太大：调高 `workerSteps` 或拆分任务。

**报告无效。** 任务进入 `needs_changes`，并附上系统写的反馈（全部 criterion ID、校验错误、提交记录 artifact 的引用）。派发会在同一会话里继续，工具可用，所以 worker 还能补跑没跑完的验证。验收仍然需要一份合格的报告；主控 不会代写。

**中止原因。** worker 进程结束时，原因会原样上报：带峰值的 `WORKER_MEMORY_LIMIT`、`WORKER_MEMORY_GUARD_FAILED`、`WORKER_TOKEN_BUDGET`，或 “OpenCode process exited; inspect server.log and memory report”。

## 报告

worker 的最终回答必须包含一个符合 `WorkerReportSchema` 的 JSON 对象。校验之前，不涉及任何主张的格式缺陷会被修正，并记录在 `reportSubmissions[].normalizations`：

- 从 markdown 代码块或前后文字中取出对象；
- 丢弃未知的顶层键；acceptance 结果、checks 和 blockers 条目上的未知键被丢弃，其中的字符串值保留为 evidence 行；
- 超过 6,000 字符的 summary 被截断；
- 缺失的 `changedFiles`、`checks`、`deviations`、`blockers` 补为空数组；
- 上报了不在 `workerChecks` 里的 check，移入 `deviations`；没上报的 worker check 记为 `not_run`，它永远不能满足 `ready_for_review`。

以下内容绝不修正：任务/计划/run/attempt 身份、criterion 覆盖、状态、`met`/`pending_supervisor`/已执行 check 所要求的 evidence，以及 outcome 的一致性。这些不合格的报告会由 `reporter` agent 重交一次：禁用全部工具，使用同一会话、run 和 attempt，共享任务期限，上限 120 秒。它的用量单独记录在 `report-submission-<runId>.json`。重交期间任务保持 `running`；不要再次派发。

任务消息里带有 `REPORT_TEMPLATE`：已填好本次运行身份、每个 criterion ID 和每个 worker check 名称的报告骨架。

## 修订还是更新

| | `workflow_plan_amend` | `workflow_plan_update` |
|---|---|---|
| 字段 | `checks`、`allowedPaths`、`resources` | 除执行身份外的全部 |
| `planRevision` | 不变 | +1 |
| worker 报告、反馈、证据 | 保留 | 清除 |
| 会话、工作区、attempts、恢复预算 | 保留 | 保留 |
| 可用状态 | 除 `verifying` 和终态外的任何状态 | 不能是 `running`、`verifying`、`queued` 或终态 |
| 记录 | `amendment-<id>.json`，含前后值和原因；在 status 和 handoff 里列出 | `plan-v<n>.json` 和新的 `configuration-v<n>.json` |

修订的值也会写进任务保存的覆盖项，所以之后的计划更新会保留它们。如果上一轮验证用的是计划内的检查，修订 `checks` 会清除已验证指纹，因为那一轮已不能覆盖现在的计划；用显式 `selection` 跑的轮次不受影响。在空闲任务上修订 `allowedPaths` 会重新计算 `scopeViolations`。对运行中任务修订的资源从下一次派发起生效。

在 `failed`、`interrupted` 或 `blocked` 任务上做计划更新，下一次派发仍需要诊断反馈并消耗恢复预算。执行身份（`id`、`repository`、`baseRef`、`fetchRemote`、`branch`、`provider`、`mode`、`workspaceMode`、`dependencies`）永不改变；需要改就另建任务。`refreshRepositoryProfile=true` 会在新修订中采用当前 profile。

## 验证

每一轮有一个 `verificationRunId`、一个 `verification-<id>.json` artifact 和若干 `verify-<id>-<check>.log`。检查按顺序在任务工作区执行，带上契约的 `environment`，不占 worker 槽，也不受内存守卫约束。

- 默认遇到第一个失败的检查就停。`continueOnFailure:true` 会把每个检查都跑完；只要有一个失败，这一轮仍算失败。
- 每条结果有 `status`、`exitCode`、`durationMs` 和日志名。失败的检查还有 `tail`，即输出的最后 1,500 个字符（超时或启动失败时是错误信息）；退出码不在 0–255 范围内时有 `exitDetail`：十六进制码，常见的 Windows NTSTATUS 值还带名称，例如 `0xC0000005 access violation`。
- `rerun:"failed"` 要求上一轮已结束、属于同一计划修订和同一次 worker 运行，并且它的源码指纹与当前一致。它沿用上一轮的 selection；上一轮通过的检查被复制过来，`reusedFrom` 指向实际执行它的那一轮，其余的重新执行。新一轮的 artifact 记录 `rerunOf`。任何源码改动、返工运行或计划更新都会让复用失效。
- 只有当所选检查全部有通过的结果、且结束时源码指纹没变，这一轮才算通过。
- `workflow_verify_stop` 中止本轮并等待进程树退出；已完成的结果保留，不授予任何东西。

验收时会把最新一轮的结果与它的 selection 比对，并把已验证指纹与当前源码比对。`review_allowed` 契约可以改用 `verification:{mode:"review_only",omittedCoverage:[...]}` 验收。

## 等待

`workflow_wait {ids,after,timeoutMs}` 在所列任务的 revision 超过游标时返回，最长 25 秒。

`node dist/src/cli.js wait <id>...` 在一个进程里串起这些读取，最多八个 ID，输出一个 JSON 对象 `{reason,tasks,attention?}`。

- `--until attention`（默认）在某个任务处于 `awaiting_review`、`needs_changes`、`needs_replan`、`blocked`、`failed`、`interrupted`、`accepted`、`integrated`、`cancelled`，或带有 `queueError` 时返回。`attention` 列出这些任务 ID。
- 第一次读取时已处于终态的任务会被忽略，除非所列任务全部是终态，或它们的状态之后又变了。
- `--after <id>=<revision>` 会排除该任务，直到它的 revision 超过这个值。没有游标时，已处于需关注状态的任务会立即返回。
- `--until change` 在游标之后出现任何 revision 变化时返回；没给游标时以第一次读取为基线。
- `--timeout-ms` 限定整个等待；超时会输出最新快照并以 2 退出。Ctrl+C 以 130 退出。两者都不改变任何任务。

CLI 会对暂时的读取失败自动重连，从不派发工作。

## 概览与归档

`workflow_status {}` 返回 `{scope,total,matched,countsByStatus,tasks,hint}`，每个任务一行精简信息，最新的在前：ID、标题、状态、修订号、`needsSupervisor`、仓库、工作区、分支、模型、`updatedAt` 和 `idleDays`。`scope` 为 `active`（默认；除 accepted、integrated、cancelled 之外的全部）、`all` 或 `archived`。可以用 `status`、`repository`（按路径比较，Windows 上不区分大小写）和 `limit`（默认 50，最多 200）缩小范围。

`workflow_archive {ids,removeWorktree?}` 逐个处理每个 ID，并分别报告结果。

- 只有 `accepted`、`integrated`、`cancelled` 的任务能归档，并且不能有未完成的任务在 `dependencies` 里引用它。
- 任务目录从 `.runtime/tasks/<id>` 移到 `.runtime/archive/<id>`，里面的东西一样都不删。分支和 `.runtime/workers/<id>` 下的 OpenCode 会话状态保留。
- ID 继续被占用。`workflow_status {id}` 和 `scope:"archived"` 仍能读到该任务；其它工具会提示它已归档。
- `removeWorktree:true` 会对安装目录 `worktrees/` 下的 worktree 执行不带 `--force` 的 `git worktree remove`。worktree 里有已修改或未跟踪的文件时 Git 会拒绝；此时任务不会被归档，并返回错误。原地工作区永远不会被动。

没有取消归档的工具；把目录移回去即可恢复任务。

## 模型

在 provider 固定机制出现之前创建的旧任务，会在下一次显式派发时固定其 provider 配置、模型和 tags。计划更新和修订都保留已固定的快照。`workflow_status` 报告固定的模型、tags、选择理由、`modelConfigPinned`、`costCurrency` 和 `pricingConfigured`。

## 旧任务

- 没有 `workerChecks` 的契约：worker 自行选择有界的增量检查，并记录在 criterion evidence 里。过去由工作流生成的、把全量测试指派给 worker 或 主控 的指令，已被 主控 自选验证取代。
- 在验证轮次机制出现之前记录的检查结果，会在新一轮验证或派发清除它们之前归档为一轮。
- 没有恢复计数的任务从零开始计；`attempts` 仍然统计每一次派发。
- 没有 `environment`、`workerSteps` 或新状态字段的任务，行为等同于这些字段未设置；`workerSteps` 回退到机器默认值。
- 任务上的 `infrastructureRetryCredits` 会放宽它的恢复上限；它由维护者针对工作流自身的缺陷授予，主控 不能自行授予。
