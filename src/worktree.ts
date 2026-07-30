import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { basename, join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { SUBAGENT_WORKTREES } from "./types.js";

export async function createWorktree(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  signal?: AbortSignal,
): Promise<{ branch: string; path: string }> {
  const rootResult = await pi.exec("git", ["rev-parse", "--show-toplevel"], {
    cwd: ctx.cwd,
    signal,
  });
  if (rootResult.code !== 0)
    throw new Error(
      `worktree:true requires a Git worktree: ${rootResult.stderr.trim() || ctx.cwd}`,
    );
  const root = realpathSync(rootResult.stdout.trim());
  const id = randomUUID().slice(0, 8);
  const branch = `pi-background-agents/${Date.now()}-${id}`;
  mkdirSync(SUBAGENT_WORKTREES, { recursive: true, mode: 0o700 });
  const path = join(SUBAGENT_WORKTREES, `${basename(root)}-${id}`);
  const result = await pi.exec(
    "git",
    ["-c", "core.hooksPath=/dev/null", "worktree", "add", "-b", branch, path],
    { cwd: root, signal },
  );
  if (result.code !== 0)
    throw new Error(
      `Could not create worktree: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  return { branch, path: realpathSync(path) };
}
