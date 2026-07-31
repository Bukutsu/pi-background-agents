# Changelog

## 0.4.5

- Security: worktree resumes now require the saved worktree and current project to share the same Git repository.
- Security: `bg` output strips ANSI/OSC terminal controls and unsafe control characters before storage and rendering.
- Fix: failed worktree creation no longer attempts to delete a potentially pre-existing generated-name branch.
- Release: regenerated `bun.lock` with the declared local Prettier dependency.

## 0.4.4

- Security: untrusted children now filter project and ancestor `AGENTS.md`/`CLAUDE.md` files while preserving the user's global context file.
- Fix: narrow-terminal widgets truncate every rendered line to the requested width.
- Fix: background start failures and stopped/timed-out results use error styling without label-text false positives.
- Fix: steering a completed/non-streaming child now reports an error instead of silently losing guidance.
- Cleanup: deduplicated session cleanup and session-prefix lookup; removed redundant thinking/setup logic; status now shows tool failures and render labels are capped.

## 0.4.3

- Security: untrusted children no longer load project `AGENTS.md`/`CLAUDE.md` context files (loader now built with `noContextFiles` when the parent hasn't trusted the checkout).
- Security: storage roots (`<agent-dir>/pi-bg`, `sessions`) are chmod'ed 0700 at startup before SessionManager can create them with default perms.
- Fix: a shutdown landing between worktree creation and session setup no longer leaks the worktree/branch (guard moved inside the cleanup boundary).
- Fix: a fork whose session file was written before a sanitize/append failure no longer leaves an orphaned file.
- Cleanup: inlined `getSubagentHeading`, dropped write-only `BgJob.done`/`activeTools` fields, dropped redundant `mkdirSync`/`_context` params, sync entrypoint, `STATE_ICONS` export removed.
- Docs: `/bg` queue-mode no longer promises recoverable output after exit; status wording says non-active sessions.

## 0.4.2

- Removed the foreground `chain` workflow (the last blocking path in a package built for backgrounding; the parent model can pass a prior subagent's output into the next spawn's prompt).
- Removed the `PI_BG_PROVIDERS` dynamic provider loader (ran package imports during global extension init; the host's provider registry is already forwarded to children).
- Surface cleanup: `/bg` rejects undocumented forms (bare pid, unknown args) instead of silently acting or no-op'ing; status icon map inlined; status lookup no longer scans the durable index twice; `message` documented as steer-only.
- npm `files` whitelist trimmed (README and LICENSE are always included).

## 0.4.1

- Security: children only load project resources when the parent already trusted the checkout (`projectTrusted` propagated from `ctx.isProjectTrusted()`); previously every child defaulted to trusted and would execute an untrusted repo's `.pi/extensions`.
- Security: dropped project-local `pi-bg.config.json` provider loading (ran before project trust); providers load only from the explicit `PI_BG_PROVIDERS` env var.
- Security: resume validates the session file is a regular file inside the pi-bg session dir and the saved cwd is inside the parent project or a pi-bg worktree; tampered index records are rejected.
- Security: `pi-bg` storage dirs are chmod'ed to `0700` (tightens pre-existing dirs); bg shell jobs now clear stale launcher `PI_*` env before setting current values.
- Fix: chain steps now abort their session on timeout or parent cancellation (previously a hung child ran forever, invisible to `/bg`).
- Fix: child `ctx.shutdown()` during a running spawn now stops the job (shutdown handler wired to the job controller again).
- Fix: shell jobs and spawns check the shutdown guard and abort with the parent lifecycle, so no process starts or survives after shutdown begins.
- Fix: `steer` keeps an explicit `queue`/`continue` choice; completion delivery uses the steered value instead of the spawn-time capture.
- Fix: failed `git worktree remove` no longer strands the branch/registration (`worktree prune` + branch deletion).
- Fix: ambiguous sessionId prefixes are rejected instead of silently targeting the first match.
- Fix: fresh sessions that fail during setup no longer leak an unindexed session file.
- Fix: unhandled-rejection risk in `JobManager.track` (finally-derived promise now caught).
- Chain steps are now transient in-memory sessions (no unresumable durable files), and `chain` with a non-spawn action is rejected.
- Docs: README now documents `chain` (foreground, `{previous}` substitution, transient), accurate spawn/chain return semantics, env vars, and valid PIDs in examples.

## 0.4.0

- Removed the blocking `tasks` parallel mode; parallel work now uses multiple `subagent` spawns in one turn, each running in the background.

## 0.3.0

- Added custom native Pi TUI renderers (`renderCall` and `renderResult`) for `bg` and `subagent` tools.
- Added session environment variable propagation (`PI_SESSION_ID`, `PI_SESSION_FILE`, `PI_PROVIDER`, `PI_MODEL`, `PI_REASONING_LEVEL`) for background bash tasks.
- Added support for Pi 0.83.0 `ctx.scopedModels` model resolution and strict scope enforcement when spawning subagents.
- Suppressed duplicate TUI custom message rendering (`display: false`) on steered background completions.

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
