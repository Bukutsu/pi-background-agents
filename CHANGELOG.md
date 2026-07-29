# Changelog

## 0.2.0

- Fixed background shell tool registration and process-tree cancellation.
- Added bounded shell output capture and background completion messages.
- Subagents now inherit only active parent tools and cannot recursively call `bg` or `subagent`.
- Writing subagents are serialized while read-only subagents retain bounded parallel execution.
- Added validated per-subagent working directories within the parent project.
- Made subagent finalization idempotent and failure messages resumable.
- Added strict typechecking and a prepublish check.

## 0.1.0

- Initial release.
