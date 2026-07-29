---
name: git-worktree
description: Use when spawning multiple writing subagents that will edit files in parallel. Instructs the agent to automatically create an isolated Git worktree per subagent, pass it as cwd, and clean up after merging. Non-SWE users benefit most since parallel edits without worktrees will silently conflict.
---

# Git Worktree Skill

Use this skill whenever you plan to run two or more subagents that will edit, write, or refactor files at the same time.

Without isolated worktrees, parallel writing subagents share the same checkout and will overwrite each other's changes.

## When This Applies

- Spawning two or more subagents with write/edit/bash tools.
- Running parallel feature work, refactors, or fixes simultaneously.

## Workflow

### 1. Create a Worktree Per Subagent

Before spawning each writing subagent, create an isolated branch and checkout:

```bash
git worktree add -b <branch-name> /tmp/worktrees/<branch-name> main
```

Example for two subagents:

```bash
git worktree add -b task-auth /tmp/worktrees/task-auth main
git worktree add -b task-tests /tmp/worktrees/task-tests main
```

### 2. Spawn Each Subagent With Its Own cwd

Pass the worktree path as `cwd` when calling the subagent tool:

```
subagent(
  description: "Implement auth",
  cwd: "/tmp/worktrees/task-auth",
  prompt: "..."
)

subagent(
  description: "Write tests",
  cwd: "/tmp/worktrees/task-tests",
  prompt: "..."
)
```

### 3. Review and Merge

After subagents finish, inspect each branch and merge back:

```bash
git -C /tmp/worktrees/task-auth log --oneline -5
git checkout main && git merge task-auth --no-ff -m "feat: merge task-auth"
git merge task-tests --no-ff -m "feat: merge task-tests"
```

### 4. Clean Up

```bash
git worktree remove /tmp/worktrees/task-auth
git worktree remove /tmp/worktrees/task-tests
git branch -d task-auth task-tests
git worktree prune
```

## Rules

- One worktree per writing subagent. Never share a worktree between two subagents.
- Read-only subagents (read, bash, grep) do not need worktrees. Run them directly in the main cwd.
- Always clean up worktrees after merging to avoid stale checkouts.
- If a merge has conflicts, resolve them in the main checkout before removing the worktree.
