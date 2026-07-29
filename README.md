# pi-bg

[![CI](https://github.com/Bukutsu/pi-bg/actions/workflows/ci.yml/badge.svg)](https://github.com/Bukutsu/pi-bg/actions/workflows/ci.yml)

Background task execution and subagent delegation extension for [Pi](https://pi.dev).

Runs shell commands and isolated subagent tasks in the background while the main agent session continues.

## Installation

```bash
pi install git:github.com/Bukutsu/pi-bg
```

## Features

- **Background shell execution**: Run non-blocking terminal commands via the `bg` tool.
- **Subagent delegation**: Delegate tasks to separate subagent instances via the `subagent` tool.
- **Session persistence**: Maintain subagent conversation state across multiple turns using session IDs.
- **Configurable completion behavior**: Queue subagent results for the user's next prompt or wake the parent agent immediately upon completion.
- **Interactive task management**: View running jobs and terminate processes using the `/bg` command.

## Tools

### `bg`

Runs a shell command in the background using `bash -c`. Output is logged to a temporary file in `/tmp/pi-bg`.

#### Parameters

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `command` | `string` | Yes | — | Shell command to execute. |
| `timeoutSec` | `number` | No | `600` | Timeout in seconds (min: `1`, max: `2147483`). |

#### Behavior & Output

- Output (stdout and stderr) is written to `/tmp/pi-bg/<uuid>.log`.
- Returns immediately after spawning the process.
- When execution finishes, the result entry (`pi-bg-result`) is appended to session history.
- Results are truncated to Pi's standard 50 KB or 2,000-line limit, keeping the tail and linking to the full log.
- Log files are automatically deleted upon successful completion (exit code `0`), unless output was truncated. For failed, timed-out, or truncated runs, log files are retained.

#### Example

```json
{
  "command": "npm test",
  "timeoutSec": 300
}
```

---

### `subagent`

Spawns an isolated `pi` background process to execute a subagent task.

#### Parameters

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `prompt` | `string` | Yes | — | Task instructions for the subagent. |
| `sessionId` | `string` | No | Generated UUID | Session ID for stateful subagent conversations. |
| `completion` | `string` | No | `"continue"` | Delivery mode: `"queue"` or `"continue"`. |
| `model` | `string` | No | Parent model | Target model specifier (e.g. `anthropic/claude-3-5-sonnet` or model ID). |
| `thinking` | `string` | No | — | Thinking effort level (`"off"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"`). |
| `systemPrompt` | `string` | No | — | Additional system instructions appended to the subagent prompt. |
| `tools` | `string` | No | — | Comma-separated list of allowed tool names. |
| `timeoutSec` | `number` | No | `600` | Timeout in seconds (min: `1`, max: `2147483`). |

#### Behavior

- **Session persistence**:
  - Subagents use Pi SDK sessions stored in `/tmp/pi-bg/sessions`.
  - When `sessionId` is omitted, a new session is created and its ID is returned.
  - A supplied `sessionId` must identify an existing subagent session.
  - Reusing a `sessionId` while that session is running results in an error.
- **Completion modes**:
  - `"queue"` (default): Delivers subagent results to context. If the parent agent is idle when completed, the result is queued (`nextTurn`) and status displays `bg done` without triggering an agent turn until the user sends a message.
  - `"continue"`: Delivers result and immediately triggers a new agent turn (`triggerTurn: true`) if the parent agent is idle.
- **Project context**: The SDK session runs in the parent working directory with Pi's normal resource discovery.
- **System prompt**: `systemPrompt` is appended through Pi's `DefaultResourceLoader`; no temporary prompt file is created.

#### Examples

Single background task:

```json
{
  "prompt": "Analyze code coverage report in coverage/lcov.info",
  "model": "anthropic/claude-3-5-haiku",
  "thinking": "low",
  "tools": "read,grep,find,ls"
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
  "completion": "continue"
}
```

## CLI Command (`/bg`)

The `/bg` command manages running background processes.

- `/bg`: Displays an interactive selection menu in TUI mode to stop a running background job. Displays PID, command summary, session ID (if applicable), and elapsed runtime. If no jobs are active, displays a notification.
- `/bg <pid>` or `/bg kill <pid>`: Stops the process with the given PID.

## Keyboard Shortcut

- **Ctrl+Shift+B**: Opens the background job manager. Same interactive selector as `/bg`.

### Process Termination

- On Unix/Linux, process termination sends `SIGINT` to the process group. If the process does not exit within 2 seconds, `SIGKILL` is sent.
- On Windows, termination uses `taskkill /T` (graceful) falling back to `taskkill /F` (forceful).
- When the parent `pi` session shuts down (`session_shutdown`), all active background jobs are terminated immediately (`SIGKILL`).

## Status Line Indicators

`pi-bg` registers a status line item (`bg-jobs`) when background processes or pending results exist:

- `● <N> bg`: Indicates `<N>` background jobs are currently running.
- `● <N> bg done`: Indicates `<N>` queued subagent results are completed and waiting for the user's next turn.
- `● <N> bg · <M> bg done`: Indicates active background jobs and queued results simultaneously.

Status clears automatically when all background jobs complete and queued results are consumed at the start of the next turn.

## Data Storage & Cleanup

- Logs and temporary session files are stored in `/tmp/pi-bg` (`/tmp/pi-bg/sessions` for subagent sessions).
- Log files older than 24 hours are automatically deleted when a new `pi` session starts (`session_start`). This includes stale subagent session directories.

## Extension Events

`pi-bg` emits events on the shared `pi.events` bus so other extensions can react to background task lifecycle:

- **`bg:task_end`**: Emitted when any background task (shell or subagent) finishes. Payload: `{ pid, command, exitCode, signal, timedOut, isSubagent, sessionId }`.
