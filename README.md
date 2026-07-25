# pi-bg

Background execution and subagent delegation for [Pi Coding Agent](https://pi.dev).

Runs long commands and delegated tasks asynchronously so your main conversation stays responsive and your context window stays clean.

## Features

- **`bg` tool**: Runs bash commands in the background without blocking the main agent.
- **`subagent` tool**: Delegates tasks to isolated subagent processes with optional model, thinking level, system prompt, and tool restrictions.
- **`/bg` command**: Interactive menu to check and stop active jobs.
- **Status bar**: Minimal `● N bg` indicator in Pi's status bar.
- **Automatic completion updates**: Delivers job results directly to the chat when tasks finish or time out.
- **Zero dependencies**: Uses Node.js standard libraries only.

## Installation

```bash
pi install git:github.com/Bukutsu/pi-bg
```

## Usage

### Interactive Command

- Type `/bg` to pick and stop active tasks.
- Type `/bg kill <pid>` to stop a task by PID.

### Tools

Run a command in the background:

```json
{
  "command": "npm test",
  "timeoutSec": 300
}
```

Delegate a task to a subagent with custom model, effort, or restricted tools:

```json
{
  "prompt": "Inspect auth module for security issues",
  "description": "Security Audit",
  "model": "anthropic/claude-3-5-haiku",
  "thinking": "low",
  "tools": "read,grep,find,ls"
}
```
