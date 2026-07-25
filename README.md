# pi-bg

Minimal background execution extension for [Pi Coding Agent](https://pi.dev).

## Features

- **`bg` tool**: Runs long bash commands asynchronously without blocking Pi execution.
- **`/bg` command**: Interactive task manager to view and kill running background tasks directly.
- **Status bar**: Live `⚙ X bg` indicator in Pi's status bar.
- **Auto-signal**: Delivers exit notifications directly to the session when jobs complete or time out.
- **Timeout guard**: Auto-terminates stalled background process groups.
- **Zero external runtime dependencies**: Uses standard Node.js libraries.

## Install

```bash
pi install git:github.com/Bukutsu/pi-bg
```

## Usage

- **`/bg`**: Interactive TUI selector to view and stop running tasks.
- **`/bg kill <pid>`**: Kill a task by PID directly.

The agent can invoke the `bg` tool for long-running processes:

```json
{
  "command": "npm test",
  "timeoutSec": 300
}
```
