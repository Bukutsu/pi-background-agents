# Changelog

## 0.2.0

- Renamed the package to `pi-background-agents`.
- Added durable SDK-native subagent sessions, resume, status history, steering, and exact per-run usage.
- Added fresh and forked context modes plus persistent Git worktrees for parallel edits.
- Added effective model, thinking level, and live tool activity to the bordered jobs widget.
- Added cross-process session ownership, stale-run recovery, and parent replacement guards.
- Kept child working directories inside the trusted parent project unless the package creates the worktree.
- Added bounded shell output, private truncation logs, timeout handling, and completion delivery modes.
- Removed recursive `bg` and `subagent` access from children.
- Added a `/bg` slash command to inspect and stop active background jobs.
- Subagents emit a `Model fallback: …` notice when a requested model cannot be resolved.

## 0.1.0

- Initial release.
