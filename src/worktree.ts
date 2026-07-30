import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { SUBAGENT_WORKTREES } from "./types.js";

export async function removeWorktree(
  pi: ExtensionAPI,
  cwd: string,
  path: string,
  branch?: string,
): Promise<void> {
  try {
    await pi.exec("git", ["worktree", "remove", "--force", path], { cwd });
  } catch {}
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {}
  if (branch) {
    try {
      await pi.exec("git", ["branch", "-D", branch], { cwd });
    } catch {}
  }
}

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
  try {
    const result = await pi.exec(
      "git",
      ["-c", "core.hooksPath=/dev/null", "worktree", "add", "-b", branch, path],
      { cwd: root, signal },
    );
    if (result.code !== 0)
      throw new Error(
        `Could not create worktree: ${result.stderr.trim() || result.stdout.trim()}`,
      );
  } catch (error) {
    await removeWorktree(pi, root, path, branch);
    throw error;
  }
  let resolvedPath = path;
  try {
    resolvedPath = realpathSync(path);
  } catch {}
  return { branch, path: resolvedPath };
}
