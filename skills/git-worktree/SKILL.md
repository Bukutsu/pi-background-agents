---
name: git-worktree
description: Workflow and instructions for creating, using, managing, and merging Git worktrees for parallel agent development. Use when isolated branching, concurrent feature editing, or clean multitasking in Git is needed.
---

# Git Worktree Workflow

Use Git worktrees to isolate parallel subagent tasks or concurrent code changes without dirtying the main working tree.

## When to Use Worktrees

- Running writing subagents in parallel on separate features.
- Testing experimental refactors without stashing or switching branches.
- Reviewing or building multiple features concurrently.

## Standard Workflow

### 1. Create a Worktree

Create an isolated branch and directory for the task:

```bash
git worktree add -b feature-task /tmp/worktrees/feature-task main
```

### 2. Perform Work in the Worktree

Run subagents or commands inside the worktree path `/tmp/worktrees/feature-task`.

### 3. Merge Changes Back

Once verified, commit changes in the worktree and merge into main:

```bash
git checkout main
git merge feature-task --no-ff -m "feat: merge feature-task"
```

### 4. Clean Up

Remove the worktree checkout and delete the branch:

```bash
git worktree remove --force /tmp/worktrees/feature-task
git branch -d feature-task
git worktree prune
```

## Quick Commands Reference

| Action | Command |
| --- | --- |
| **List worktrees** | `git worktree list` |
| **Add worktree** | `git worktree add -b <branch> <path> [<base-branch>]` |
| **Remove worktree** | `git worktree remove <path>` |
| **Prune stale entries** | `git worktree prune` |
