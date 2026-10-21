# Task examples / 任务示例

[`repository-preferences.json`](repository-preferences.json) is a portable request for `workflow_repository_config_update`. Replace its path, review its validation policy, and save reusable defaults once. Subsequent tasks can provide just ID, repository, goal and acceptance. See [repository preferences](../docs/en/repository-preferences.md).

First use now automatically initializes a minimal profile. If already initialized, replace the example's ID and `expectedRevision=0` with the actual ID/current revision from `workflow_repository_config` before applying it.

[`repository-preferences.json`](repository-preferences.json) 是 `workflow_repository_config_update` 的可移植请求示例。替换路径、审查验证策略后，一次保存共同偏好；后续任务只需填写 ID、仓库、目标和验收项，详见[仓库偏好](../docs/zh-CN/repository-preferences.md)。

首次使用现已自动最小建档。如果已经初始化，应用示例前将 ID 和 `expectedRevision=0` 替换为 `workflow_repository_config` 返回的实际 ID/当前版本。

## Project-local drafts / 项目本地草案

Keep project-specific task drafts and their generators in `skills/orchestrate-code/repositories.local/<id>/examples/` and `scripts/`. Use `profile://scripts/<file>` in check commands and arguments. Stored drafts are references; review the current repository rules, baseline and acceptance criteria before creating a task.

项目专用草案和生成脚本放在对应 profile 的 `examples/` 与 `scripts/` 下。检查命令通过 `profile://scripts/<file>` 引用。草案仅供参考；创建任务前核对当前仓库规则、基线和验收要求。

See [protocol](../docs/en/protocol.md) / [交接协议](../docs/zh-CN/protocol.md) and [schemas](../src/schema.ts).
