# pi-bg

The smallest [Pi](https://pi.dev) package combining background shell jobs and resumable SDK-native subagents—without agent definitions, worktrees, workflows, or runtime dependencies.

Runs shell commands and isolated subagent tasks in the background while the main agent session continues.

## Installation

```bash
pi install git:github.com/Bukutsu/pi-bg
```

## Features

- **Background shell execution**: Run non-blocking terminal commands via the `bg` tool.
- **Subagent delegation**: Delegate tasks to separate subagent instances via the `subagent` tool.
- **Session persistence and control**: Resume, inspect, steer, or stop subagents using session IDs.
- **Safe bounded parallelism**: Run four read-only subagents concurrently; any subagent with tools beyond `read`, `grep`, `find`, and `ls` is conservatively serialized.
- **Restricted inheritance**: Children inherit the parent's active tools, never gain unavailable tools, and cannot recursively call `bg` or `subagent`.
- **Configurable completion behavior**: Queue subagent results for the user's next prompt or wake the parent agent immediately upon completion.
- **Session results**: Keep background completion output in Pi's native session history.
- **Interactive task management**: View and stop running jobs using `/bg`.

## Tools

### `bg`

Runs a shell command in the background using Pi's native process API.

#### Parameters

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `action` | `string` | No | `"spawn"` | `"spawn"`, `"status"`, or `"stop"`. |
| `command` | `string` | For spawn | — | Shell command to execute. |
| `completion` | `string` | No | `"continue"` | Delivery mode: `"queue"` or `"continue"`. |
| `pid` | `number` | For stop | — | Running shell job ID. |
| `timeoutSec` | `number` | No | `600` | Timeout in seconds (min: `1`, max: `2147483`). |

#### Behavior & Output

- When execution finishes, the result (`pi-bg-result`) is delivered immediately (or queued for the next turn if `completion: "queue"`).
- Output is bounded while running and truncated to Pi's standard 50 KB or 2,000-line limit, keeping the tail.
- Failed or truncated output tails are retained in a private temporary log.

#### Example

```json
{ "command": "npm run build", "timeoutSec": 300 }
{ "action": "status" }
{ "action": "stop", "pid": -1 }
```

---

### `subagent`

Runs an isolated Pi SDK session in the background. It can also inspect, steer, or stop active subagents.

#### Parameters

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `action` | `string` | No | `"spawn"` | `"spawn"`, `"status"`, `"steer"`, or `"stop"`. |
| `prompt` | `string` | For spawn | — | Task instructions for the subagent. |
| `description` | `string` | No | Prompt prefix | Short label shown in job status. |
| `sessionId` | `string` | For control/resume | Generated UUID | Session ID to continue, inspect, steer, or stop. |
| `message` | `string` | For steer | — | Message sent to a running subagent. |
| `completion` | `string` | No | `"continue"` | Delivery mode: `"queue"` or `"continue"`. |
| `model` | `string` | No | Parent model | Target model specifier (e.g. `anthropic/claude-3-5-sonnet` or model ID). |
| `thinking` | `string` | No | — | Thinking effort level (`"off"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"`). |
| `tools` | `string` | No | Parent tools except `bg` and `subagent` | Comma-separated allowlist that can only narrow the parent's active tools. |
| `cwd` | `string` | No | Parent working directory | Existing working directory inside the parent project. |
| `timeoutSec` | `number` | No | `600` | Timeout in seconds (min: `1`, max: `2147483`). |

#### Behavior

- **Session persistence**:
  - Subagents use Pi SDK sessions stored in `/tmp/pi-bg/<pid>/sessions`.
  - When `sessionId` is omitted, a new session is created and its ID is returned.
  - A supplied `sessionId` must identify an existing subagent session.
  - Reusing a `sessionId` while that session is running results in an error.
- At most four subagents run simultaneously. Only subagents restricted to `read`, `grep`, `find`, and `ls` are considered read-only; all others are serialized. Queued work remains cancellable.
- Pi can launch independent read-only work in parallel by making multiple `subagent` calls in one turn.
- Child tool access is inherited from the parent, excluding `bg` and `subagent`. An explicit `tools` value may narrow but never expand that access.
- `cwd` must resolve to an existing directory within the parent project. `pi-bg` deliberately does not create or merge worktrees.
- **Completion modes**:
  - `"queue"`: Holds the result for the user's next turn without waking the parent agent.
  - `"continue"`: Delivers result and immediately triggers a new agent turn (`triggerTurn: true`) if the parent agent is idle.
- **Project context**: The SDK session runs in the parent working directory with Pi's normal resource discovery. Concurrent writing subagents can conflict, so parallel calls should normally be read-only unless work is isolated externally.

#### Examples

Single background task:

```json
{
  "prompt": "Analyze code coverage report in coverage/lcov.info",
  "model": "anthropic/claude-3-5-haiku",
  "thinking": "low",
  "tools": "read,bash"
}
```

Stateful subagent follow-up:

```json
{
  "prompt": "Refactor auth middleware based on your previous findings",
  "sessionId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
}
```

Autonomous continuation mode:

```json
{
  "prompt": "Run benchmark suite and write report",
  "description": "Benchmark report",
  "completion": "continue"
}
```

Inspect or redirect active work:

```json
{ "action": "status" }
{ "action": "steer", "sessionId": "<session-id>", "message": "Focus on the failing integration test" }
{ "action": "stop", "sessionId": "<session-id>" }
```

## CLI Command (`/bg`)

The `/bg` command manages running background processes.

- `/bg`: Displays an interactive selection menu in TUI mode to stop a running background job. Displays job ID, command summary, session ID (if applicable), and elapsed runtime. If no jobs are active, displays a notification.
- `/bg <id>` or `/bg kill <id>`: Stops the job with the given ID.

### Process Termination

Shell jobs use Pi's native local bash backend for platform shell selection, timeout handling, and process-tree termination. When the parent session shuts down, all running and queued jobs are aborted and disposed.

## Status Line Indicator

`● <N> bg` shows the number of running or queued background jobs and clears when none remain.

## Data Storage & Cleanup

- Logs and temporary session files are isolated by Pi process under `/tmp/pi-bg/<pid>` (`sessions/` for subagent sessions).
- Temporary storage is operational state, not a permanent archive; the operating system may clear it.
