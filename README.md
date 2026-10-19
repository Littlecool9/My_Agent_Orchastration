# 本地 Agent 工作流

**日常启动：在项目文件夹输入 wt → claude，然后输入 /orchestrate-code 你的任务。** 用户级 MCP 与显式技能接入见下文；不再需要每次传启动脚本或插件参数。

主控继续使用 Claude Code CLI / Codex 桌面端的原模型与订阅。通过本项目的 MCP 工具，把实现交给后台 OpenCode，再由主控独立审查和验收。

**执行状态以 workflow_config 返回的运行值为准；已有本地 API 配置保留，任务不会因开关开启或 daemon 重启而自动派发。** 项目依赖保存在本文件夹。Claude 使用一次性用户级 MCP 与显式技能接入；原模型、登录与其他设置保留，Codex 配置未改，也没有为 alpha 建分支或 worktree。添加 Key 本身不会启动任务。

**开始验证请按 [START-VERIFY.md](START-VERIFY.md)**：填 Key → 本地 doctor → 显式 API 只读探针 → 临时加载 Claude → 你明确开工后才执行 #244。

日常启动、任务提示词、返工、恢复和交付检查见 [DAILY-GUIDE.md](DAILY-GUIDE.md)。

## 先审查这些文件

| 文件 | 内容 |
|---|---|
| `skills/orchestrate-code/SKILL.md` | 主控的规划、委派、返工、验收规则；只显式启用 |
| `workflow.config.json` | 执行开关、并行/重试上限、模型与接口 |
| `src/engine.ts` | 任务状态、依赖、独立验证与验收条件 |
| `src/opencode.ts` | OpenCode 启动、独立凭据/会话、任务提示词 |
| `src/tools.ts` | Claude/Codex 可调用的 MCP 工具 |
| `prompts/executor.txt` / `prompts/investigator.txt` | 独立角色系统提示词、局部自治与升级边界 |
| `src/protocol.ts` / `src/schema.ts` | 有版本的任务契约、结果和返工协议及校验 |
| `examples/alpha-244.json` | 首轮任务草案：启动时 fetch origin，以 origin/master 的实际提交建 worktree |
| `VERIFICATION.md` | 实测结果、尚未验证的部分 |

## 架构与行为

```text
Claude / GPT 主控（原订阅）
  └─ 显式启用的 Skill + MCP stdio
      └─ 本地常驻调度 daemon（仅 127.0.0.1，随机令牌）
          ├─ 任务记录、报告、验证日志
          └─ 每次任务运行的 OpenCode server（独立 API 环境）
              └─ Kimi / DeepSeek 官方 API
```

执行请求使用 OpenCode `/session/:id/prompt_async` 异步提交，之后以有界短请求轮询会话状态和消息；不再用同步 HTTP 请求等待整轮执行，避免 Node fetch 的默认 300 秒响应头超时。总任务时限仍然生效，取消会中断轮询并停止进程。轮询的短暂失败最多重试三次，不重复提交执行请求。最终结果必须属于本轮消息且会话已空闲，仍经原有严格报告校验。失败时保留运行编号、底层网络错误和最近消息快照。

恢复持久会话前会检查空 assistant 消息（包括中断后仅剩 step-start/reasoning 的消息及空 APIError 记录）。修复只在会话空闲时进行：先归档完整原历史，再通过 OpenCode 单条消息 DELETE 接口精确删除，最后核对其余消息完全一致；归档或校验失败则停止，不发送模型请求。有效文本、工具调用及工具错误记录保留；不会使用可能回滚工作区文件的 revert。原始数据库维护备份位于 .runtime/session-backups，逐次修复归档位于相应 worker 目录的 history-repair-*.json。

调度服务是确定性的程序，没有额外规划模型。主控决定任务目标、计划、依赖、返工内容与验收；执行模型处理详细代码调查和实现。后台保存完整记录，主控默认只收到有长度限制的摘要。任务与执行会话的对应关系会持久化，返工继续原 OpenCode 会话。

状态：`planned → ready → running → awaiting_review → verifying → awaiting_review → accepted`。返工为 `needs_changes → running`；异常为 `failed/interrupted`，恢复需要诊断反馈。默认最多同时执行 2 个任务，每个任务最多 3 次派发，每次最长 90 分钟；达到上限交由主控分析，不无限重试。经审计确认的工作流基础设施故障可由维护者为单个任务记录 infrastructureRetryCredits；历史 attempts/runId 不回退，worker 无权授予额度。workflow_status 显示原始尝试次数、补偿额度、有效上限及剩余额度。

v0.2 增加 blocked / needs_replan。后者必须先经主控 workflow_plan_update 才能继续。计划版本 planRevision 与状态版本 revision 独立；每次执行另有唯一 runId，结果必须对应 taskId、planRevision、runId、attempt。计划更新使旧报告、反馈和检查失效，但不清空总尝试次数。

内置 build/plan/general/explore/scout 已禁用，执行请求只指定 executor 或 investigator，task/plan 工具禁用；拒绝恢复含内置 Plan 历史的会话。自定义角色允许局部实现与调试，不允许擅改固定设计。任务以 JSON 契约交接，结果是应用层严格 JSON Schema 校验的报告。OpenCode 1.19.3 原生 json_schema format 在本地测试中导致持久会话读取报 OutputFormatJsonSchema 错误，所以采用普通消息承载 JSON，由应用校验，不使用该原生格式。普通文本、缺字段、错误版本和不完整的完成声明均不能进入待验收。

`prepare`、`dispatch`、`verify` 在 executionEnabled=false 时都会拒绝执行。任务创建只记录计划。执行 agent 的“完成”只能进入待验收。`verify` 在模型外真实运行任务中列出的命令，记录退出码和日志；`review accept` 要求全部检查通过，而且源码自验证后没有变化。主控还必须实际读代码检查功能覆盖，服务器无法替模型证明语义正确。

MCP 客户端关闭不停止 daemon，所以已派发任务可继续。主控关闭后不会自动产生下一轮规划或验收。daemon 意外终止时，IPC 监护进程负责停止 OpenCode；下次启动把未完成任务标为 interrupted，不自动重放。

## 本地审查与测试

需要 Node.js 22+、Git。当前机器已安装本项目依赖与构建产物。换机器时在本文件夹运行：

```powershell
npm ci
npm run build
npm test
npm run doctor
npm run connections
```

`npm test` 只操作 `work/workflow-tests/` 内的临时 Git 仓库，并使用 localhost 模拟模型；不调用真实模型。`doctor` 仅检查程序版本、配置及 Key 是否存在，不输出 Key、不请求模型。Windows 某些受限执行环境需要允许启动本地 OpenCode 二进制。

## 审查后配置 API

编辑已经准备好的 `.env.local`：

```dotenv
MOONSHOT_API_KEY=在本地填写
DEEPSEEK_API_KEY=在本地填写
```

首轮只使用 Kimi 时可以只填它的 Key。默认 Kimi 地址为中国开放平台 `https://api.moonshot.cn/v1`；国际站 Key 请在配置中改为 `https://api.moonshot.ai/v1`。模型默认 `kimi-k3`。DeepSeek 使用官方接口，默认 `deepseek-flash`，可以改为账号实际可用的模型。**真实账号的模型权限、限额与参数兼容性，要在收到启动指令后验证，当前没有试调。** 不会自动更换供应商或回退到主控订阅。

密钥只通过工作流本地文件/环境读入，不写进 MCP 配置。执行进程会剔除继承的主控 API/OAuth/GitHub 环境凭据，只注入当前供应商的 Key，并使用独立 XDG 配置/数据目录。`.env.local`、运行数据和本地覆盖配置都在 `.gitignore` 中。日志做尽力脱敏；它不等同于完整秘密检测。

直接编辑 `workflow.config.json` 即可；`workflow.local.json` 是可选的个人配置，若使用应复制完整基础配置后修改，它完整替代基础配置，不接受仅含执行开关的片段。修改配置不会自动改变常驻 daemon 的运行值。`workflow_config` 同时返回运行中的 `executionEnabled`、磁盘的 `diskExecutionEnabled`、当前选用文件 `configFile` 和 `restartRequired`；配置无效时返回 `configError`。修改 Key/配置后，在没有任务运行或验证时用 `npm run stop` 再 `npm run start` 重启；重启保留已存计划，不会自动派发任务，现有 MCP 连接可继续使用。

## 接入 Claude Code（优先）

本机使用用户级接入：运行普通 `claude` 后，通过 `/orchestrate-code` 显式调用。一次性安装命令为 `npm run install:claude`；安装用户级 MCP 和个人技能，不改变 Claude 的登录、模型或 shell 命令。旧的 start-claude.ps1 保留作临时加载排错，不是日常入口。

运行 `npm run connections`，获得本机绝对路径的 `.mcp.json` 配置，把 `agent-orchestrator` 条目合并到准备使用的 Claude 项目或用户 MCP 配置，保留其他服务。配置只启动 Node stdio 桥，不包含 Key。

将 `integrations/claude/skills/orchestrate-code/` 整个目录复制到项目 `.claude/skills/orchestrate-code/`（或用户 `~/.claude/skills/orchestrate-code/`）。这个 Claude 专用入口使用 `disable-model-invocation: true`，通过 `/orchestrate-code` 显式调用。重新打开 Claude Code 后查看 `/mcp`，确认工具可见。保持原 Claude 订阅登录，不设置 ANTHROPIC_BASE_URL，不更改主模型。`integrations/claude.mcp.json` 也已经保存了本机连接片段。

此次迁移会安装用户级 MCP 与个人显式技能；不向 alpha 写入工作流配置。首次实际执行仍需 Key 和明确开工指令。

## 接入 Codex 桌面端

`npm run connections` 同时输出 `[mcp_servers.agent-orchestrator]` 配置片段，可合并到 Codex 的 MCP 配置；也已保存到 `integrations/codex.mcp.toml`。将 `skills/orchestrate-code/` 整个目录复制到 `~/.codex/skills/orchestrate-code/`；`agents/openai.yaml` 设置 allow_implicit_invocation=false，通过 `$orchestrate-code` 显式调用。重新打开会话后验证工具可见。此适配目前提供标准 MCP 入口和配置，尚未在实际 Codex/Claude 账户会话中验收。

Claude 入口由公共 Skill 生成，避免两份指令分别维护。修改公共 Skill 或移动文件夹后，执行 `node scripts/prepare-integrations.mjs` 重新生成本地接入文件；它不改任何客户端配置。

## 审查通过后才启动 #244

1. 你明确同意开工；确认 Key、Kimi endpoint/model，补齐 alpha 的 MSVC、CMake、VCPKG_ROOT、VULKAN_SDK、Wwise 等构建环境。
2. 将本地配置 executionEnabled 改为 true，重启 daemon；主控重新读取 #244/#230 最新内容和最新 master 的 AGENTS.md，确认任务契约。
3. 主控通过 `workflow_task_create` 导入 `examples/alpha-244.json` 中的请求；`workflow_prepare` 才会 fetch 并新建分支/worktree。此文件是草案，不是启动脚本。
4. 主控调用 dispatch，等待结果，检查实际 diff 和新增文件，调用 verify，再做 accept/rework。Debug 与 Release 的完整构建/测试由 `scripts/alpha-check.ps1` 执行；脚本需要在任务 worktree 根目录运行。
5. 输出中文汇总和 PR 描述。当前任务明确不 commit、不 push、不创建 PR、不关闭 issue。

MCP 之外也有等价 CLI，方便排错：

```powershell
# 只建立任务记录，不开始执行；开工前不需要运行这一条。
node dist/src/cli.js call workflow_task_create --file examples/alpha-244.json
# 所有其他请求同样使用 --file request.json，避免 PowerShell JSON 转义。
```

`npm run start` 仅启动调度服务，不派发任务；`npm run stop` 停止它及其活动执行进程。所有任务状态、报告、会话数据保存在 `.runtime/`，worktree 位于 `worktrees/<task-id>/`。取消保留这些数据，不回滚源码。不要在任务运行时删除运行目录。

## v0.2 的实际边界

- OpenCode 的工具权限、分支与 worktree 不是 OS 沙箱。实现 agent 有广泛 shell 权限以运行项目工具链；禁止 push 等规则和 allowedPaths 检查不能保证任意 shell 代码无法绕过。它适用于你信任的本地仓库。
- 只读 investigator 禁止写文件和通用 shell，只开放文件读取与少量 Git 查询；更复杂的只读检查由主控完成。
- prerequisites/dependencies 是调度和基线检查，不会自动合并源码。依赖结果必须在所选基线中；跨任务整合与组合测试由主控完成。
- evidence 是主控填写的引用；服务器检查运行证据与源码版本，不能判断主控有没有认真审查。报告的 token/cost 是 OpenCode 返回值，custom provider 的 cost 可能为 0，不是供应商账单。
- 任务正文、仓库规则、构建命令和 AGENTS.md 属于受信任的任务输入。执行端不会自动继承主控的客户端插件、浏览器工具或订阅额度。

## 官方参考

- [OpenCode Server](https://opencode.ai/docs/server/)、[配置](https://opencode.ai/docs/config/)、[权限](https://opencode.ai/docs/permissions/)
- [Kimi 中国开放平台](https://platform.kimi.com/docs/get-api-key)、[Kimi 接入 OpenCode](https://platform.kimi.ai/docs/guide/open-code)
- [DeepSeek 接入 OpenCode](https://api-docs.deepseek.com/quick_start/agent_integrations/opencode/)
- [Claude Code MCP](https://code.claude.com/docs/en/mcp)、[Codex MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)
