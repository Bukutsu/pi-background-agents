# pi-bg

Background execution and subagent delegation for [Pi Coding Agent](https://pi.dev).

Runs shell commands and delegated subagents in the background while the main agent keeps working.

## Why pi-bg?

Most subagent extensions are heavy, monolithic frameworks that force you to write complex YAML config files, maintain custom agent presets, or install extra runtime dependencies just to run tasks in the background.

`pi-bg` takes a simpler approach:

- **One lightweight runner for everything**: Handles both long-running bash processes (dev servers, test suites, builds) and subagent tasks under one extension.
- **No third-party runtime dependencies**: Uses Node.js standard libraries and Pi's bundled peer packages.
- **No config files required**: Delegate tasks directly with optional model, effort, system prompt, or tool restrictions right in the tool call.
- **Native CLI flags**: Uses standard `pi -p` flags under the hood (`--model`, `--thinking`, `--append-system-prompt`, `--tools`).
- **Automatic result delivery**: Subagent outputs are delivered straight to your session when complete, saving extra log-reading turns.
- **Persistent follow-ups**: Reuse a returned session ID to continue the same subagent with its existing context.

## Installation

```bash
pi install git:github.com/Bukutsu/pi-bg
```

## Usage

### Interactive Management

- Type `/bg` to inspect running tasks, including shortened subagent session IDs, and stop one.
- Type `/bg kill <pid>` to interrupt a task by PID directly. Subagents retain their session for follow-up; unresponsive processes are force-killed after two seconds.

### Background Bash Commands

Run a long process without blocking execution:

```json
{
  "command": "npm test",
  "timeoutSec": 300
}
```

### Subagent Delegation

Delegate work to an isolated subagent process with the same extensions and default tools as the main agent. Pass `tools` only to restrict it:

```json
{
  "prompt": "Inspect auth module for security issues",
  "model": "anthropic/claude-3-5-haiku",
  "thinking": "low",
  "tools": "read,grep,find,ls"
}
```

The result includes a session ID. Pass it back to continue the same subagent after its current turn finishes. Concurrent turns on one session are rejected:

```json
{
  "prompt": "Now fix the highest-severity issue",
  "sessionId": "the-returned-session-id"
}
```
