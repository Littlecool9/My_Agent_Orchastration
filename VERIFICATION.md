# 审查版验证记录

日期：2026-10-19。环境：Windows 原生、Node.js 24.13.1、Git 2.56.0.windows.1、项目内 OpenCode 1.19.3。依赖精确版本与完整解析结果保存在 package.json/package-lock.json。

## 已验证

- TypeScript 严格编译。
- 标准 MCP 客户端通过 stdio 握手、发现 12 个工具（含 workflow_plan_update）、调用工具、断开与重连；断开不会停止后台 daemon。未提供后台令牌的 HTTP 请求被拒绝。
- **真实 Windows OpenCode 二进制**连接仅监听 localhost 的假模型接口，完成读取文件工具调用并取得工具结果；关闭执行进程后重新启动，成功恢复原会话。这里没有调用 Kimi、DeepSeek 或订阅模型。
- 临时 Git 仓库中的独立 worktree，不改变原检出分支。
- executionEnabled=false 阻止准备 worktree、派发和验证。缺少 Key 时不派发。
- 模型报完成后仍待主控验收；没有独立检查、检查失败或源码变化时不能接受。
- 新增未跟踪文件计入源码指纹；超出 allowedPaths 的改动阻止验证。
- Windows Git autocrlf 的 stderr 警告不会被误当成文件路径；已修复并覆盖该回归。
- 返工继续同一 session；重试与并发限制、取消后不复活结果、daemon 状态恢复、工件路径穿越防护。
- 执行环境剔除主控凭据，只允许显式的执行 provider；Claude/Codex Skill 显式调用设置及生成文件一致性检查。
- 真实 OpenCode 请求中观察到自定义 investigator 系统提示词，未暴露写文件、task 和 Plan 工具；同一持久会话成功接收 planRevision=2 并返回对应新 runId 的严格 JSON 报告。
- 报告必须匹配 taskId / planRevision / runId / attempt，完整覆盖验收 ID 与检查名；旧报告、重复/缺失 ID、无证据完成声明、调查者声称改文件和非法 outcome 均被拒绝。
- needs_replan 不能直接重派；主控更新完整计划后才允许继续。计划更新乐观版本检查、执行身份不可变、保留会话与尝试预算、旧证据失效均已验证。blocked 的重试需要结构化诊断反馈。
- 返工必须引用当前计划和存在的验收 ID；自由文本返工被拒绝。实时 API 探针不带 --live 时，在读取 Key/创建探针任务前就拒绝执行。
- Claude Code 本地 `plugin validate` 通过；仅有未填写可选 author 元数据的警告。PowerShell 会话启动脚本通过语法解析；没有启动交互式 Claude 或安装插件。

完整套件：`npm test`，26 项全部通过（约 39 秒）。临时仓库留在项目内 `work/workflow-tests`，不是 alpha。

兼容记录：OpenCode 1.19.3 原生 format=json_schema 的试验会导致后续持久会话消息读取报 OutputFormatJsonSchema 错误。当前使用普通消息承载严格 JSON，由应用层完整校验，已实测原会话恢复。没有把普通文本当作格式错误时的备用成功结果，也没有修改 OpenCode 二进制。

## 尚未验证，审查后开工时再进行

- 真实 Kimi/DeepSeek 账户权限、余额、模型 ID、provider 参数与长任务表现。
- 新增 `npm run probe -- --provider kimi --live` 只读探针已实现，但未调用真实 API；它成功后也不代表业务编码能力或 #244 已通过。
- Claude Code 订阅会话和 Codex 桌面端实际加载这套配置及遵守 Skill 的行为。
- 主控真实 token 节省比例、实现质量与交付速度；离线测试不能证明这些指标。
- alpha 最新 master 的构建环境、Debug/Release、GPU smoke tests 与 #244 实现。
- 多个真实 issue 的源码集成。本版由主控选择集成基线并处理组合测试，不自动 merge。
- 官方 Python quick_validate.py 未能运行：本机 py launcher 指向的 Python313 无法启动。已提供 Node 自动检查技能 frontmatter、显式调用设置和两端入口一致性；它不等价于真实客户端行为验收。

## 初始交付边界（首次真实验证之前）

执行开关保持 false，两个 Key 保持空值；没有启动 #244、fetch alpha、创建 alpha 分支/worktree、修改 alpha 文件。当前迁移仅新增 Claude 用户级 MCP 与显式技能，其他 Claude 配置保留，Codex 配置未改。测试调度服务在测试结束后停止。

源码审查建议从 README 的文件表开始。主控规则是 Skill；可机械检查的执行与验收状态在 engine.ts。工具权限不是 OS 沙箱，语义正确性和是否遵守计划仍需要主控审查。

## 目录迁移与日常启动验证

- 新目录：`D:/desktop/programming/personal-projects/agents-related/agent-orchestrator`。7,091 个迁移文件全部 SHA-256 校验一致后才移除旧副本。
- 本机已注册用户级 MCP 和个人显式技能 /orchestrate-code；从 alpha 目录执行 claude mcp get 显示 User scope、Connected，命令参数指向新目录。
- 除新增 MCP 条目外，.claude.json 其他内容哈希保持一致；.claude/settings.json 哈希保持一致。没有更改登录、模型或 shell 的 claude 命令。
- 新目录下 26 项离线测试全部通过（约 39 秒）；测试临时仓库改为项目内 work/workflow-tests。
- 工作流配置查询增加 projectRoot，主控能在普通项目目录中定位工作流安装与示例。
- 日常说明已精简为 wt → claude → /orchestrate-code。原启动脚本仍保留作备用。
- 实际模型 API 和 #244 没有启动；交互式 Claude 对任务分工的行为仍需首次真实任务验证。


## 2026-10-19：长任务传输与恢复修复

- 真实 alpha 任务第一次派发于 20:18:32 UTC，20:23:40 UTC 报 TypeError: fetch failed，约 308 秒。旧日志没有保存 cause/code，不能把具体底层异常当成已经证实；同步长 POST 与 Undici 默认 300 秒响应头超时不匹配的设计缺陷已确认。
- 改为 OpenCode prompt_async 异步提交和短请求轮询。每次 HTTP 请求最长 15 秒，整轮仍使用 taskTimeoutMinutes；取消中断轮询和执行进程。不自动重发结果不明的 POST，短暂读取失败最多重试三次。
- 最终结果需要属于本次 messageID，且会话空闲、消息完成；旧消息、部分文本、仅工具调用和输出截断不能当作成功。原有 TaskSpec/WorkerReport 校验仍然生效。失败保存最近消息快照与更具体的网络错误。
- 完整 37 项离线测试通过（约 41 秒）。另补实际 OpenCode 中途取消后原 session 恢复的测试，通过（约 14 秒）。
- 在真实 OpenCode 1.19.3 上连接本地模拟模型，故意等待 310 秒才返回第一段响应头；该测试通过，业务测试段用时 312.538 秒，随后成功恢复同一持久会话并校验下一轮报告。没有使用真实模型 API。
- MCP 回归测试现使用独立临时安装，不会停止日常使用的 daemon。
- 实际 daemon 已重启并启用新代码，executionEnabled=true。alpha-prefabs-244 保留 failed、planRevision=1、attempts=1 和原 runId；其原始任务记录备份为 task-before-infrastructure-repair.json。
- 为上述一次工作流基础设施故障登记 infrastructure_retry_credited 审计事件及 infrastructureRetryCredits=1。有效派发上限为 4，剩余 3 次；历史失败和尝试编号不回退，全局 maxAttempts=3 未改，未自动派发或支付新的模型请求。
- 重启前后 worktree 源码指纹、任务契约、原 session、baseCommit 和路径一致。继续执行应由原 Claude 主控检查现有改动后，带当前版本的结构化诊断反馈调用 workflow_dispatch；不要重新 prepare 或创建任务。


## 2026-10-19：中断后的空 assistant 历史修复

- 第二次实际派发在实现前被 Moonshot 400 拒绝：中断遗留的 assistant 没有 finish、text 或工具调用，只有 step-start 和空 reasoning；另有一条空 APIError assistant。原来的中断测试在返回流式内容前取消，未覆盖这种持久化半截消息，已更正。
- 新增 src/opencode-history.ts。每次 worker 恢复会话前，仅在空闲状态归档原始历史，再通过本机 OpenCode 1.19.3 的 DELETE /session/{sessionID}/message/{messageID} 删除空 assistant；验证剩余消息逐项不变。有效文本、完整工具调用和工具错误不删除。不使用 revert，不直接修改 SQL。
- 真实 OpenCode 测试先接收部分 reasoning，确认空 reasoning part 已持久化，再硬终止进程。普通续跑自动清理该消息，在拒绝空 assistant 的本地模拟模型上完成工具调用并返回当前运行的有效报告。未先人工清理测试会话。完整 42 项离线测试全部通过（约 46 秒）。
- 实际 alpha 会话共 21 条消息；一致性 SQLite 备份后，通过 API 仅删除 msg_155d510ef001dP98069WiONwCD 和 msg_155e18548001Bp2oJgnIxNHegu，保留其余 19 条消息及全部 parts 原始数据。备份目录和归档路径记录在任务 session_history_repaired 审计事件中。
- 维护使用虚假模型 Key，所有模型 endpoint 指向本机不可用端口，仅调用本地历史接口，未请求真实模型。维护故障工件单独命名，不会覆盖原 failure-2.json。
- 原 session ses_eaa2f1e83ffevswa3R6POfwTKC、worktree 源码指纹、任务契约、baseCommit 和第二次失败工件均保持不变。daemon 已重启加载修复。
- 为第二次基础设施故障增加一次审计补偿：attempts 仍为 2，infrastructureRetryCredits 累计 2，有效上限 5，剩余 3 次。任务仍 failed、planRevision=1，没有派发或重建任务。主控可带 AC-01/AC-08 的当前版本结构化诊断反馈继续 workflow_dispatch。
