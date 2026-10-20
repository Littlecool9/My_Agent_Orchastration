# 仓库偏好

[English](../en/repository-preferences.md) | [文档目录](README.md)

仓库偏好在本地保存可复用的工作流约定。任务自动继承，并各自保存完整合同。仓库专用脚本优先由对应仓库维护，也可以放在本地 profile 旁边。

## 绑定与配置仓库

先读取 `workflow_repository_config {repository}`，查看绑定、profile 版本/哈希、偏好和实际资源上限。创建时调用 `workflow_repository_config_update`，传入稳定 `id`、仓库绝对路径、`expectedRevision=0` 和 `preferences`。例如：

```json
{
  "repository": "C:/path/to/project",
  "id": "my-project",
  "expectedRevision": 0,
  "preferences": {
    "defaults": {
      "provider": "deepseek",
      "baseRef": "HEAD",
      "workspaceMode": "worktree",
      "verificationPolicy": "review_allowed"
    },
    "requirements": { "constraints": ["保留已有作者文件头及 CRLF。"] },
    "limits": { "workerMemoryLimitMB": 2048 }
  }
}
```

此例明确允许主控选择仅代码审查验收。需要独立命令的仓库保留默认 `commands_required`，并在 defaults 或任务输入中提供检查。[完整示例](../../examples/repository-preferences.json)还包含资源默认值。

profile 写入编排器安装目录的 `skills/orchestrate-code/repositories.local/<id>/profile.json`，同时创建相邻的 `scripts/`。该区域已加入 gitignore。更新已有 profile 时传入当前 revision；更新替换整份 preferences，增加版本并影响新任务，不派发工作或修改已有任务。

绑定依据是 Git 的实际 common directory，在 Windows 上规范化路径大小写。同仓库 worktree 共用绑定，同名仓库和独立 clone 各自独立。备份或迁移时复制整个本地 profile 目录，再用相同 ID、当前版本和 `rebind=true` 明确绑定到新仓库。重复绑定及意外复用 ID 会被拒绝；损坏的 profile 会明确报错，避免悄悄丢失偏好。

## 默认值与始终适用的要求

- `defaults`：基线/fetch、分支前缀、provider、工作区模式、任务模式、重复的非目标、决策、上下文引用、步骤、自治约定、constraints、allowedPaths、worker/主控检查、验证策略和资源设置。
- `requirements.constraints`：始终追加并去重；任务替换默认 constraints 时也保留。它们属于合同指令，沿用现有任务约束的审查与协作边界。
- `requirements.verificationPolicy=commands_required`：禁止任务降低为仅代码审查验收。
- `limits`：仓库的 `workerMemoryLimitMB`、`taskTimeoutMinutes` 上限；机器配置同时作为硬上限。任务/默认值超过两者较小值时拒绝，未指定资源时采用实际限额。worker 启动和整轮执行遵守任务与当前机器预算的较小值；这些设置没有为主控验证命令新增内存守护。

任务提供的标量和数组替换 defaults，包括显式空数组；resources 按字段合并。需要保留的共同规则放入 `requirements.constraints`。临时覆盖只影响该任务，长期修改通过 profile 更新操作完成。

## 创建简短合同

`workflow_task_create` 的 `spec` 只必填四项：

```json
{
  "spec": {
    "id": "feature-one",
    "repository": "C:/path/to/project",
    "goal": "在约定模块边界内实现本次功能。",
    "acceptance": [{ "id": "AC-01", "requirement": "写明可观察的验收条件。" }]
  }
}
```

按需补充本次设计决策、范围、检查或步骤。旧的完整合同仍然支持。没有仓库覆盖时，内置默认值为 contract/plan 版本 1、`baseRef=HEAD`、分支 `codex/<id>`、DeepSeek、worktree、一个 adaptable 步骤及限定在任务范围内的局部自治。标题默认取目标前 120 字符。实现合同仍需一条检查，除非明确允许仅代码审查。

任务保存完整解析后的 `TaskSpec` 和 `configuration-v<planRevision>.json`。该工件包含完整 profile、版本/哈希、原始任务覆盖、实际限额和字段来源（`builtin`、`repository_default`、`task`、`repository_requirement` 或 `previous_plan`）。执行身份在计划修订中保持不变。worker 收到解析后的合同及 profile 身份，常规状态仅增加 profile 引用，不重复返回整份偏好。

## 修改计划与偏好

`workflow_plan_update` 的 `spec` 支持局部字段，例如 `{goal:"澄清后的目标"}`，同时提供任务 ID、`expectedPlanRevision` 和 `changeReason`。未指定下一计划版本时自动递增。解析仍使用任务冻结的 profile，并保留已有任务覆盖；旧版本配置工件可继续读取。

在明确的计划修订中设置 `refreshRepositoryProfile=true`，才采用当前仓库偏好。执行身份继续保持原值，其来源可能标为 `previous_plan`。单独编辑 profile 不会改变运行中或已有任务；活动、已验收及终态任务的计划限制继续适用。

## 验证与脚本

默认 `commands_required` 保持独立命令验收。`review_allowed` 允许主控在 `workflow_review` 验收时明确指定：

```json
{
  "id": "feature-one",
  "decision": "accept",
  "rationale": "说明代码审查内容，以及省略测试的依据。",
  "evidence": ["具体源码位置及验收项证据"],
  "verification": { "mode": "review_only", "omittedCoverage": ["自动化回归测试"] }
}
```

它记录审查时的源码指纹和遗漏范围，不声称测试通过。空 checks 本身不授予该权限；明确要求测试证明的验收项仍须提供实际证据。`workflow_verify` 对实现任务仍要求实际命令。

本地脚本可在检查的 command 或 args 中使用 `profile://scripts/check.ps1`，解析为当前 profile 目录中的实际文件，支持带空格路径。检查在任务实际工作目录执行。缺失文件、目录越界及指向目录外的引用均拒绝。脚本另行维护；配置快照保存解析路径和偏好，不复制脚本内容。本功能不引入规则文件同步钩子。
