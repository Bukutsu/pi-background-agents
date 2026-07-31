# pi-background-agents

Background shell jobs and SDK-native subagents for [Pi](https://pi.dev).

`pi-background-agents` provides two tools: `bg` for non-blocking shell commands and `subagent` for running child Pi sessions in process with their own context and history.

## Trust model

This is a trusted-local developer tool, not a sandbox. `bg` runs shell commands with the parent environment, and subagents may inherit the parent session's active tools, including filesystem and shell access. Use it only with prompts, repositories, and providers you trust; use an OS/container sandbox separately when that boundary matters.

## Install

```bash
pi install git:github.com/Bukutsu/pi-background-agents
```

## `bg`

Use `bg` for long-running commands like test suites, builds, package installs, and local dev servers.

```json
{ "command": "npm run build", "timeoutSec": 300 }
{ "action": "status" }
{ "action": "stop", "pid": 42 }
```

Parameters:

| Name         | Default      | Purpose                                                             |
| ------------ | ------------ | ------------------------------------------------------------------- |
| `action`     | `"spawn"`    | `spawn`, `status`, or `stop`                                        |
| `command`    |              | Shell command for `spawn`                                           |
| `completion` | `"continue"` | `continue` wakes Pi when done; `queue` waits for the next user turn |
| `pid`        |              | Job ID for `stop`                                                   |
| `timeoutSec` | `600`        | Timeout in seconds (1 to 2,147,483)                                 |

Output is limited to 50 KB or 2,000 lines. Truncated or failed jobs save their full output to a private log file in a temporary directory.

## `subagent`

Use `subagent` to run tasks in a separate context, model, or working directory.

```json
{
  "prompt": "Review the authentication flow for correctness",
  "description": "Auth review",
  "thinking": "high"
}
```

Spawning a subagent returns immediately while the child runs in the background. When `completion` is `"queue"`, the result stays in Pi's in-memory next-turn queue. Exiting or reloading before your next message drops that queued notification, but the subagent session and its status record remain saved.

Parameters:

| Name          | Default                     | Purpose                                                                                                                            |
| ------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `action`      | `"spawn"`                   | `spawn`, `status`, `steer`, or `stop`                                                                                              |
| `prompt`      |                             | Task prompt for a new or resumed session                                                                                           |
| `description` | Truncated prompt (30 chars) | Short label shown in status                                                                                                        |
| `sessionId`   | New ID                      | Target session ID for resume, status, steer, or stop                                                                               |
| `message`     |                             | Guidance queued after the child's active turn (steer only)                                                                         |
| `completion`  | `"continue"`                | `continue` wakes Pi when done; `queue` waits for the next user turn                                                                |
| `model`       | Parent model                | Model override validated against `scopedModels`; falls back to parent model if no scope is active; on resume, restores saved model |
| `thinking`    | Parent thinking level       | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`                                                                       |
| `tools`       | Parent active tools         | Comma-separated tool list (can only reduce access)                                                                                 |
| `cwd`         | Parent directory            | Directory path inside the parent project                                                                                           |
| `worktree`    | `false`                     | Create a Git branch and worktree for parallel edits                                                                                |
| `context`     | `"project"`                 | `project` starts a fresh context; `fork` copies the parent's context                                                               |
| `timeoutSec`  | `600`                       | Timeout in seconds                                                                                                                 |

### Parallel edits

Set `worktree: true` when subagents edit code in parallel:

```json
{
  "prompt": "Implement the approved authentication change",
  "worktree": true,
  "context": "fork"
}
```

`pi-background-agents` creates a Git branch from `HEAD` and an isolated worktree in `<agent-dir>/pi-bg/worktrees`. It skips Git checkout hooks during creation, returns the branch and directory paths, and leaves them on disk for you to review, merge, or delete.

Do not combine `cwd` and `worktree: true` in the same call.

### Context

Setting `context: "project"` starts a fresh session with standard resource discovery in the target directory. Put all necessary instructions and decisions directly in the prompt.

Setting `context: "fork"` copies the parent's current conversation into the child session, removing orchestration tool calls and package completion messages. The child gets a flat snapshot of the conversation rather than a branch of the parent's session tree.

### Resume

Subagent sessions are saved under `<agent-dir>/pi-bg` and persist across Pi restarts. Pass a session ID to resume:

```json
{
  "sessionId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "prompt": "Apply the fixes from your review"
}
```

Resuming reopens the child's directory and restores its saved model and thinking level. Resuming fails if the session file or directory no longer exists.

### Model selection and scopedModels

`pi-background-agents` respects Pi's active `scopedModels` configuration:

- When `scopedModels` is active in Pi (version 0.83 or later), explicit `model` requests are checked against the allowed scope. If the requested model is in scope, the subagent uses it. If it is not in scope, the spawn call fails with an error listing available models.
- If no `scopedModels` list is active on the host, requested `model` parameters are ignored with a warning, and the child uses the parent session's model. This prevents subagents from making unauthorized calls to unconfigured providers.
- When no `model` parameter is provided on a new spawn, the child inherits the parent's current model or the matching scoped model entry.
- Resuming a subagent (`sessionId`) restores the child's saved model unless you specify a new model within the active scope.
- Explicit `thinking` level settings are always respected.

### Status and control

```json
{ "action": "status" }
{ "action": "status", "sessionId": "<session-id>" }
{ "action": "steer", "sessionId": "<session-id>", "message": "Check the retry path too" }
{ "action": "stop", "sessionId": "<session-id>" }
```

Running `status` returns active subagents and up to 5 recently updated non-active sessions. The rendered table displays model, thinking level, status, activity, turn count, tool calls and failures, duration, and cost. The machine-readable output includes directory path, token counts, and session file path.

Steering queues a message for the child to process after its current turn completes.

## Tool inheritance

Children inherit the parent's active tools and discover tools in their own working directory. Built-in tools and extension tools carry over if present in the child directory. `bg` and `subagent` are stripped from children to prevent recursive delegation.

Passing a `tools` parameter restricts the child to the specified subset of active parent tools.

Child extensions follow Pi's print-mode lifecycle. Reloading the parent extension or switching sessions stops running jobs and discards stale completion messages.

## User interface

Active background work renders in a widget above the editor. Subagent rows display `<model>:<thinking>` and current activity.

Run `/bg` to list or stop active background tasks:

```text
/bg
/bg kill 42
```

## Environment variables

Commands run through `bg` receive the parent environment plus session identity variables, with launcher variables refreshed:

| Variable             | Value                     |
| -------------------- | ------------------------- |
| `PI_SESSION_ID`      | Current session ID        |
| `PI_SESSION_FILE`    | Current session file path |
| `PI_PROVIDER`        | Current model provider    |
| `PI_MODEL`           | Current model ID          |
| `PI_REASONING_LEVEL` | Current thinking level    |

## Storage

| Data                               | Location                      |
| ---------------------------------- | ----------------------------- |
| Subagent session records and index | `<agent-dir>/pi-bg`           |
| Worktrees                          | `<agent-dir>/pi-bg/worktrees` |
| Temporary output logs              | Temp directory                |

Worktrees are not deleted or merged automatically. Temporary logs clean up according to OS policies. Child token usage appears in subagent status and completion reports, but does not alter the parent's already-finished tool call totals.

## Design constraints

The package stays focused on background execution. The following choices ensure reliability:

- Store a durable session index. Session files alone cannot reliably track resumed subagents across different working directories or worktrees.
- Take `getSessionStats()` snapshots before and after runs. Reading only final messages misses intermediate turns, tool calls, and compaction usage.
- Guard session changes with generation numbers and shutdown flags. Abort controllers reset on new sessions; generation tracking prevents old callbacks from running into new sessions.
- Pair extension loading with shutdown handlers. Loading extension tools without lifecycle hooks leaves resources unmanaged.
- Update UI status and activity in real time. Live widgets make running tasks visible and steerable without polling.
- Support `steer`. Steering allows guiding a running subagent without canceling its active turn.
- Offer both `continue` and `queue` completion modes. `continue` wakes the parent for autonomous tasks; `queue` waits for user input to avoid unwanted API costs.
- Sanitize fork context structurally. History must retain tool calls and results while removing orchestration calls and completion messages.
- Preserve partial output. When a run aborts or encounters an error, text produced before the failure remains available.
- Reconcile stale runs via process IDs. PID checks distinguish active children from leftover `running` records after a crash.
- Leave worktrees on disk. Automatic cleanup risks deleting uncommitted edits.
- Block `bg` and `subagent` inside children. Disabling nested delegation keeps task ownership clear and prevents infinite loops.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).
