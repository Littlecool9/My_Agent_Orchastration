# Task examples / 任务示例

[`repository-preferences.json`](repository-preferences.json) is a portable request for `workflow_repository_config_update`. Replace its path, review its validation policy, and save reusable defaults once. Subsequent tasks can provide just ID, repository, goal and acceptance. See [repository preferences](../docs/en/repository-preferences.md).

First use now automatically initializes a minimal profile. If already initialized, replace the example's ID and `expectedRevision=0` with the actual ID/current revision from `workflow_repository_config` before applying it.

[`repository-preferences.json`](repository-preferences.json) 是 `workflow_repository_config_update` 的可移植请求示例。替换路径、审查验证策略后，一次保存共同偏好；后续任务只需填写 ID、仓库、目标和验收项，详见[仓库偏好](../docs/zh-CN/repository-preferences.md)。

首次使用现已自动最小建档。如果已经初始化，应用示例前将 ID 和 `expectedRevision=0` 替换为 `workflow_repository_config` 返回的实际 ID/当前版本。

[`alpha-244.json`](alpha-244.json) demonstrates a complete versioned implementation contract: decisions, context, ordered steps, autonomy, acceptance criteria, incremental worker checks and independent supervisor checks.

该文件展示完整的带版本实现契约，包括设计决定、上下文、步骤、自治边界、验收项、worker 增量检查和主控独立检查。

It is specific to the alpha prefab project and external issues #244/#230, with Windows C++ toolchain assumptions. It is a draft, not a generic task or a command to start work. Neither installation nor daemon startup imports it automatically.

它针对 alpha prefab 项目及外部 #244/#230，依赖 Windows C++ 工具链；它是草案，不是通用任务或开工指令，安装和启动 daemon 都不会自动导入它。

## Use a local copy / 使用本地副本

1. Run `npm run prepare:example:alpha` (or `node scripts/prepare-alpha-example.mjs`) from the installation root. General setup and integration preparation never generate this example.
2. Edit the generated `integrations/local/alpha-244.json`: set `spec.repository` to your actual alpha checkout. Check-script paths already point to this installation.
3. Have the supervisor reread current issues, repository rules, prerequisites and acceptance criteria. Adapt the contract and verification scope to the actual task.
4. Only after explicitly starting this work, let the supervisor create, prepare and dispatch the task.

在安装根目录单独运行 `npm run prepare:example:alpha`，编辑 `integrations/local/alpha-244.json` 中的实际仓库路径；检查脚本路径已指向本机安装。通用 setup 和接入准备不生成此示例。让主控重新读取当前 issue、仓库规则、依赖和验收要求，再按实际任务调整契约与验证范围。明确开工后才创建、准备和派发。

The local copy is ignored by Git. Regeneration retains its task settings while refreshing check-script paths. To design a different task, use a different task ID and review every project-specific assumption; do not dispatch the bundled draft unchanged.

本地副本由 Git 忽略。重新生成会保留任务设置并刷新检查脚本路径。编写其他任务时使用不同 ID，检查所有项目专用假设，不要原样派发草案。

See [protocol](../docs/en/protocol.md) / [交接协议](../docs/zh-CN/protocol.md) and [schemas](../src/schema.ts).
