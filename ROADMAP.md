# pi-bg Roadmap

## Product position

**The minimal async runtime for Pi:** durable background shell jobs and controllable in-process SDK subagents, without profiles, workflow languages, or configuration files.

`pi-bg` should compete on a smaller surface that is easy to understand and dependable. It should not reproduce `pi-subagents` feature-for-feature.

## Principles

1. Keep the extension usable without configuration.
2. Prefer Pi SDK and TUI primitives over custom protocols.
3. Add controls that improve ordinary async work, not orchestration syntax.
4. Keep shell jobs as a first-class differentiator.
5. Share a working directory by default and state that limitation clearly.
6. Require evidence of demand before adding a dependency or persistent format.

## Success criteria

- A new user can launch and control work without reading configuration documentation.
- Shell and subagent jobs expose consistent spawn, status, and stop behavior.
- Queue, cancellation, timeout, shutdown, continuation, and rendering paths remain small enough to audit directly.
- The extension remains under roughly 750 source lines unless a larger feature replaces equivalent code.
- Runtime dependencies remain limited to Pi-provided packages.

## Phase 1: Keep the current runtime auditable

**Status: complete**

### Deliverables

- Document that concurrent writing subagents share one checkout and may conflict.
- Ensure every terminal state is reported exactly once.
- Keep queue, cancellation, timeout, and shutdown logic direct and local.

### Exit criteria

- No known path can report a stopped or timed-out job as successful.
- No queued job remains visible after cancellation.

## Phase 2: Unify shell-job controls

**Status: complete**

The generic shell runner is `pi-bg`'s strongest unique feature, but models currently have weaker controls for shell jobs than for subagents.

### Deliverables

Extend `bg` with the same small action vocabulary:

- `spawn`: current command behavior;
- `status`: list active shell jobs;
- `output`: return the bounded tail of a job's output file;
- `stop`: terminate the process group.

Keep `{ "command": "..." }` backward compatible as shorthand for `spawn`.

### Limits

- Do not stream output into memory.
- Do not add log databases or transcript protocols.
- Keep files under the existing temporary job directory.
- Return only a bounded output tail.

### Exit criteria

A parent agent can launch, inspect, and stop a shell job without relying on `/bg` or issuing another shell command.

## Phase 3: Add small, session-local history

**Status: complete**

Active jobs disappear too quickly to diagnose completed work. Add a bounded in-memory history rather than a durable run database.

### Deliverables

Retain the latest 20 completed jobs with:

- kind and description;
- terminal state;
- start time and duration;
- model and session ID for subagents;
- token usage and cost when available;
- output path for shell jobs;
- a bounded result excerpt.

Expose history through existing `status` actions and `/bg`. Keep native result cards as the primary completion UI.

### Limits

- History resets when Pi exits or reloads.
- No search, pagination, database, artifact browser, or Fleet UI.
- Store excerpts, not full duplicate transcripts.

### Exit criteria

A user can answer “what just finished, how long did it take, and what did it cost?” without inspecting session files.

## Phase 4: Improve safe delegation guidance

**Status: complete**

### Deliverables

- Teach the parent prompt to use parallel calls for independent read-only work.
- Warn against parallel writers in one checkout.
- Recommend one writing subagent at a time unless the user has isolated the work externally.
- Add examples for research fan-out, sequential follow-up using `sessionId`, steering, and cancellation.

### Limits

- No automatic prompt classifier.
- No tool-based read/write capability inference.
- No worktree manager.

### Exit criteria

Normal Pi behavior chooses safe delegation patterns without introducing a workflow API.

## Phase 5: Evaluate one convenience feature from real usage

**Priority: only after Phases 1–4**

Choose at most one based on repeated user friction:

1. **Minimal named presets:** a few built-in read-only roles implemented as defaults, not YAML discovery.
2. **Opt-in worktree command:** only if parallel writing is a common demonstrated need.
3. **Durable run recovery:** only if losing work across Pi exits is a recurring problem.

Do not implement any option preemptively. Each one changes the product boundary and requires a separate design decision.

## Explicit non-goals

- Chain or workflow DSLs
- Parallel wrapper tools
- Dynamic fan-out
- Schedulers or cron
- Persistent agent memory
- Fleet dashboard
- RPC or supervisor protocols
- Watchdog model reviews
- LSP orchestration
- Structured acceptance contracts
- Custom permission system
- Profile/configuration hierarchy
- Transparent recovery across Pi process death

Pi already provides parent-agent reasoning, sibling tool-call parallelism, sessions, model resolution, and TUI components. `pi-bg` should compose those features instead of rebuilding them.

## Release sequence

| Release | Scope | User-visible result |
| --- | --- | --- |
| Next patch | Phase 1 | Existing behavior stays auditable and limitations become explicit. |
| Next minor | Phase 2 | Shell jobs gain model-accessible status, output, and stop controls. |
| Following minor | Phase 3 | Recent job outcomes and usage remain inspectable during the session. |
| Documentation update | Phase 4 | Safer, clearer delegation patterns without new runtime machinery. |
| Later decision | Phase 5 | At most one evidence-backed convenience feature. |

## Decision rule for future proposals

A feature belongs in `pi-bg` only when all are true:

1. It improves asynchronous shell or subagent work for ordinary users.
2. Pi does not already provide the capability.
3. It does not require a workflow language or configuration system.
4. Its maintenance cost is proportional to how often it will be used.
5. It can be explained in one README paragraph and audited without special infrastructure.

Otherwise, document how to accomplish it with Pi or recommend `pi-subagents` for that use case.
