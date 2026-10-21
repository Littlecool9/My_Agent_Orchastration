# Updating an installed workflow

[简体中文](../zh-CN/updating.md) | [Documentation](README.md)

An installed Skill is a copy. Editing or pulling this repository does not update that copy, an already loaded Skill, or a client's cached MCP tool descriptions. Use the explicit updater after changing local source or receiving a new release.

## Run an update

On Windows, double-click `update.cmd` in the installation folder. The window stays open so you can inspect the result. PowerShell and terminal equivalents are:

```powershell
.\update.ps1
npm run update
```

The updater uses its own installation path even if launched from another directory. Default client selection is `auto`: refresh only client installations whose ownership marker names this checkout. It does not adopt another installation or overwrite unmanaged Skills. To choose clients explicitly, use `--client claude|codex|both|none`; `none` updates the backend only.

```powershell
npm run update -- --check
npm run update -- --dry-run
npm run update -- --client both
npm run update -- --pull
```

`--check` is read-only and reports source/generated/installed instruction synchronization and the recorded backend source fingerprint. It does not fetch remote versions or start the daemon. `--dry-run` shows the intended stages. `--pull` is the explicit remote-code option: it requires a clean checkout with an upstream and runs `git pull --ff-only`. Default updates apply local source, including intentional uncommitted edits; they never stash or reset it.

## What is refreshed

The updater preflights selected clients and rejects conflicting ownership/MCP registrations. It obtains an installation update lock, safely stops an idle daemon, optionally fast-forwards source, installs locked dependencies when the lock changed or no successful update recorded them, builds, regenerates the Claude Skill/MCP templates, and refreshes selected user-level Skills and this workflow's MCP registration. Matching MCP registrations remain in place. An initially running daemon is restarted after a successful update; an initially stopped daemon stays stopped until used.

Keys, `.env.local`, `workflow.local.json`, repository profiles, target repositories, worktrees and task history are retained. Profiles are not copied into client Skill directories. Updating makes no model request or task dispatch. It does not install Node.js, change supervisor accounts or rotate credentials.

The local `.runtime/update.json` records the applied source/dependency fingerprints. `--check` compares installed Skill content and Codex invocation metadata against the current source. A successful file update cannot replace instructions already loaded in an open conversation: reopen the client or reconnect its MCP server, and invoke the Skill again.

## Active work and failures

The daemon refuses idle-only shutdown while a worker, verification or locked task operation is active. No backend/client replacement begins in that case. New daemon starts are blocked during an update. Older daemons that cannot enforce idle-only shutdown are left running: finish active work, run `npm run stop` once, then rerun the updater.

Dependency/build failures leave local state intact and do not write a successful update fingerprint. Client conflicts are rechecked before installation. Client registration recovery uses the same ownership and restore behavior as setup. Fix the reported error and rerun; a daemon stopped by a failed update remains stopped. If an updater crashed, check the PID in `.runtime/update.lock/owner.json` before removing that stale lock. Do not remove a lock belonging to a running updater.

## Agent entry points

The shared repository guidance is [AGENT.md](../../AGENT.md). `CLAUDE.md` imports it with `@AGENT.md`, and `AGENTS.md` provides a discovery bridge for clients using that filename. See the official [Claude imports](https://code.claude.com/docs/en/memory#import-additional-files) and [Codex instruction discovery](https://learn.chatgpt.com/docs/agent-configuration/agents-md).

Supervisors working in other repositories read the installed `orchestrate-code` Skill. Its startup sequence/capability index covers profiles, literal allowed paths, resource limits, waiting, artifacts, verification, rework and updates. `workflow_config.guidance` provides absolute paths and wait/update commands for MCP-only discovery. Workers instead receive their role prompt and resolved task contract, and follow the target repository's instruction files.
