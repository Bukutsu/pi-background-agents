# pi-background-agents

Background shell jobs and SDK-native subagents for [Pi](https://pi.dev).

`pi-background-agents` keeps the API small: one tool for shell commands and one for child Pi sessions. Subagents run in process, inherit the parent's available tools, and keep their own context and session history.

## Install

```bash
pi install git:github.com/Bukutsu/pi-bg
```

## `bg`

Use `bg` for commands that should not block the conversation, such as test suites, builds, installs, and development servers.

```json
{ "command": "npm run build", "timeoutSec": 300 }
{ "action": "status" }
{ "action": "stop", "pid": -1 }
```

Parameters:

| Name         | Default      | Purpose                                                             |
| ------------ | ------------ | ------------------------------------------------------------------- |
| `action`     | `"spawn"`    | `spawn`, `status`, or `stop`                                        |
| `command`    |              | Shell command for `spawn`                                           |
| `completion` | `"continue"` | `continue` wakes Pi when done; `queue` waits for the next user turn |
| `pid`        |              | Job ID for `stop`                                                   |
| `timeoutSec` | `600`        | Timeout from 1 to 2,147,483 seconds                                 |

Output is limited to Pi's standard 50 KB or 2,000 lines. Failed and truncated jobs keep a private log in a process-owned temporary directory.

## `subagent`

Use `subagent` for work that benefits from a separate context, model, or working directory.

```json
{
  "prompt": "Review the authentication flow for correctness",
  "description": "Auth review",
  "thinking": "high"
}
```

The call returns immediately. Pi receives the child's final response when it finishes. `completion: "queue"` uses Pi's in-memory next-turn queue, so exit or reload before the next message discards that queued delivery; the child session and status record remain durable.

Parameters:

| Name          | Default                                         | Purpose                                                                                                                    |
| ------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `action`      | `"spawn"`                                       | `spawn`, `status`, `steer`, or `stop`                                                                                      |
| `prompt`      |                                                 | Task for a new or resumed session                                                                                          |
| `description` | Prompt itself (truncated to 30 chars if longer) | Short label shown in status                                                                                                |
| `sessionId`   | New ID                                          | Resume, inspect, steer, or stop a child                                                                                    |
| `message`     |                                                 | Guidance queued after the child's current turn                                                                             |
| `completion`  | `"continue"`                                    | `continue` wakes Pi when done; `queue` waits for the next user turn                                                        |
| `model`       | Parent or saved model                           | Model ID or provider/model specifier; an unresolvable model falls back to a default and emits a `Model fallback: …` notice |
| `thinking`    | Parent or saved level                           | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`                                                               |
| `tools`       | Parent tools                                    | Comma-separated allowlist that can only reduce access                                                                      |
| `cwd`         | Parent directory                                | Existing directory inside the parent project                                                                               |
| `worktree`    | `false`                                         | Create a branch and worktree for a new child                                                                               |
| `context`     | `"project"`                                     | `project` starts fresh; `fork` copies the current parent context                                                           |
| `timeoutSec`  | `600`                                           | Child timeout                                                                                                              |

### Parallel edits

Set `worktree: true` when subagents will edit in parallel:

```json
{
  "prompt": "Implement the approved authentication change",
  "worktree": true,
  "context": "fork"
}
```

`pi-background-agents` creates a branch from the current `HEAD` and a worktree under `<agent-dir>/pi-bg/worktrees`. Git checkout hooks are disabled during creation. It returns both paths and leaves them in place. Merging and cleanup stay under your control.

`cwd` and `worktree: true` cannot be used together.

### Context

`context: "project"` starts a fresh conversation with normal Pi resource discovery in the child directory. The prompt must contain the task and any decisions the child needs.

`context: "fork"` copies the parent's effective conversation into a new child session. It removes package completion messages and orchestration tool calls. The copy is a flattened context snapshot, not a duplicate of the parent's session tree.

### Resume

Subagent sessions live under `<agent-dir>/pi-bg` and survive Pi restarts. Resume one with its session ID:

```json
{
  "sessionId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "prompt": "Apply the fixes from your review"
}
```

A resumed child returns to its saved directory and restores its model and thinking level unless the call overrides them. Resume fails if its session file or working directory has been removed.

### Status and control

```json
{ "action": "status" }
{ "action": "status", "sessionId": "<session-id>" }
{ "action": "steer", "sessionId": "<session-id>", "message": "Check the retry path too" }
{ "action": "stop", "sessionId": "<session-id>" }
```

Status includes active sessions and the 50 most recently updated completed sessions. It reports the effective model and thinking level, directory, current activity, turns, tool calls and failures, token usage, cost, duration, and session file.

Steering does not interrupt the current turn. The message is delivered after that turn finishes.

## Tool inheritance

Children request the parent's active tool names, then load tools through normal discovery in the child directory. Built-in and rediscoverable extension tools carry over. Temporary, inline, or parent-only extension tools may not exist in the child. Spawn and status report the child's actual tool set. An explicit `tools` list can narrow access and fails if a requested tool is unavailable. `bg` and `subagent` are always removed to prevent recursive delegation.

Child extensions use Pi's print-mode lifecycle. Parent reloads and session changes stop owned jobs and suppress stale completion messages.

## UI

Running work appears above the editor. Subagent rows include a compact model and thinking label such as `<provider>/<model>:<thinking>` plus the current activity.

Use `/bg` to inspect or stop active jobs:

```text
/bg
/bg kill -1
```

## Storage

| Data                                      | Location                               |
| ----------------------------------------- | -------------------------------------- |
| Durable subagent sessions and index       | `<agent-dir>/pi-bg`                    |
| Generated worktrees                       | `<agent-dir>/pi-bg/worktrees`          |
| Temporary shell and truncated-output logs | Process-owned directory under `<temp>` |

Generated worktrees are not merged or removed automatically. Temporary logs may be cleared by the operating system. Child usage is reported by subagent status and completion messages, but it cannot be added retroactively to the already-finished parent tool call's usage total.

## Custom providers

By default, subagents can only use model providers the host has configured. To let a subagent use a provider shipped as an installed npm package (for example `antigravity`, which the host may not have configured), point `pi-bg` at it and it will register the provider with the host at load time:

- Environment variable (comma- or space-separated):

  ```sh
  PI_BG_PROVIDERS=antigravity
  ```

- Or a sibling `pi-bg.config.json`:

  ```json
  { "providers": ["antigravity"] }
  ```

Each entry is a module specifier that resolves to a [`Provider`](https://github.com/Earendil-Works/pi) object or a provider config (`{ name, baseUrl, api, models, ... }`). Once registered, models such as `antigravity/gemini-3.6-flash` become selectable via the subagent `model` parameter like any built-in provider. A package that fails to load is logged and skipped, so one bad entry does not break the extension.

## Design constraints

The implementation is intentionally small, but several pieces are required for correctness:

- Keep the durable session index. Session files alone cannot reliably find a resumed child that used another directory or worktree.
- Keep per-run `getSessionStats()` snapshots. Reading only the final assistant message misses earlier turns, retries, compaction, and tool-owned usage.
- Keep both the parent generation and shutdown guards. The abort controller is replaced when a new session starts, so it cannot identify callbacks owned by the previous session. The generation blocks those callbacks, while the shutdown flag covers the gap before replacement.
- Keep child extension binding and shutdown paired. Loading extension tools without their lifecycle hooks leaves child resources partially initialized.
- Keep the live widget and activity subscription. They make background work visible and cancellable without polling. Tracking active tool IDs also handles parallel child tools and supplies failure counts for status.
- Keep `steer`. It is the direct control path for a running SDK session and queues guidance without discarding the current turn.
- Keep both completion modes. `continue` wakes the parent for autonomous work; `queue` avoids an unsolicited model turn and its cost when the result can wait.
- Keep fork sanitization structural. Model history must retain matched tool calls and results while dropping orchestration calls, unresolved calls, and package completion messages. Copying only prose changes the parent context and can lose decisions recorded in tool results.
- Keep partial assistant output. Aborts and provider errors can end a run after useful text has streamed but before a final assistant message is stored.
- Keep stale-run reconciliation. The owner PID distinguishes a live child from a durable record left in `running` state after a crash.
- Keep generated worktrees persistent. Automatic cleanup could delete unmerged changes. The caller owns merging and removal.
- Keep `bg` and `subagent` unavailable to children. Unbounded recursive delegation makes cancellation and ownership unclear.

Features outside these constraints should earn their place. The package does not need agent roles, workflow syntax, scheduling, RPC, a transcript viewer, or automatic merging and cleanup.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).
