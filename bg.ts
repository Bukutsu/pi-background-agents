import { buildSessionContext, createAgentSession, createLocalBashOperations, getAgentDir, ModelRuntime, resolveCliModel, SessionManager, truncateTail } from "@earendil-works/pi-coding-agent";
import type { AgentSession, ExtensionAPI, ExtensionContext, SessionStats } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

let logDir: string | undefined;
const getLogDir = () => logDir ??= mkdtempSync(join(tmpdir(), "pi-background-agents-"));
const SUBAGENT_DIR = join(getAgentDir(), "pi-bg");
const SUBAGENT_SESSION_DIR = join(SUBAGENT_DIR, "sessions");
const SUBAGENT_INDEX = join(SUBAGENT_DIR, "index");
const SUBAGENT_LOCKS = join(SUBAGENT_DIR, "locks");
const SUBAGENT_WORKTREES = join(SUBAGENT_DIR, "worktrees");
const LEGACY_SUBAGENT_INDEX = join(SUBAGENT_DIR, "index.json");

type TerminalState = "finished" | "failed" | "stopped" | "timed-out" | "interrupted";

interface SubagentRecord {
  sessionId: string;
  cwd: string;
  sessionFile: string;
  model: string;
  thinking: string;
  label: string;
  createdAt: string;
  updatedAt: string;
  state: "running" | TerminalState;
  turns: number;
  toolCount: number;
  toolFailures: number;
  usage: SessionStats["tokens"] & { cost: number };
  inheritedTools: string[];
  durationSec?: number;
  branch?: string;
  context: "project" | "fork";
  modelFallback?: string;
  ownerPid?: number;
}

interface BgJob {
  pid: number;
  command: string;
  startedAt: number;
  sessionId?: string;
  controller: AbortController;
  kind: "shell" | "subagent";
  session?: AgentSession;
  activity?: string;
  badge?: string;
  baseline?: SessionStats;
  record?: SubagentRecord;
  toolFailures?: number;
  activeTools?: Map<string, string>;
  done?: Promise<void>;
  sessionLock?: string;
}

function readIndex(): Record<string, SubagentRecord> {
  let legacy: Record<string, SubagentRecord> = {};
  if (existsSync(LEGACY_SUBAGENT_INDEX)) {
    try { legacy = JSON.parse(readFileSync(LEGACY_SUBAGENT_INDEX, "utf8")); }
    catch (error) { console.warn(`Ignoring invalid legacy subagent index:`, error); }
  }
  if (!existsSync(SUBAGENT_INDEX)) return legacy;
  for (const entry of readdirSync(SUBAGENT_INDEX, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    try {
      const record = JSON.parse(readFileSync(join(SUBAGENT_INDEX, entry.name), "utf8")) as SubagentRecord;
      if (!record || typeof record.sessionId !== "string" || !/^[a-zA-Z0-9-]+$/.test(record.sessionId)) throw new Error("invalid sessionId");
      legacy[record.sessionId] = record;
    } catch (error) {
      console.warn(`Ignoring invalid subagent record ${entry.name}:`, error);
    }
  }
  return legacy;
}

function saveRecord(record: SubagentRecord) {
  if (!/^[a-zA-Z0-9-]+$/.test(record.sessionId)) throw new Error(`Invalid subagent session ID: ${record.sessionId}`);
  mkdirSync(SUBAGENT_INDEX, { recursive: true, mode: 0o700 });
  const target = join(SUBAGENT_INDEX, `${record.sessionId}.json`);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flush: true });
  renameSync(temporary, target);
}

function usageSince(current: SessionStats, baseline: SessionStats) {
  return {
    input: current.tokens.input - baseline.tokens.input,
    output: current.tokens.output - baseline.tokens.output,
    cacheRead: current.tokens.cacheRead - baseline.tokens.cacheRead,
    cacheWrite: current.tokens.cacheWrite - baseline.tokens.cacheWrite,
    total: current.tokens.total - baseline.tokens.total,
    cost: current.cost - baseline.cost,
  };
}

function sanitizeForkMessages(ctx: ExtensionContext) {
  const messages = buildSessionContext(ctx.sessionManager.getBranch()).messages;
  const resultIds = new Set(messages.flatMap((message) => message.role === "toolResult" && !["bg", "subagent"].includes(message.toolName) ? [message.toolCallId] : []));
  const callIds = new Set<string>();
  const sanitized: any[] = [];
  for (const message of messages) {
    if (message.role === "custom" && message.customType === "pi-bg-result") continue;
    if (message.role === "compactionSummary" || message.role === "branchSummary") {
      sanitized.push({ role: "user", content: `Parent conversation summary:\n${message.summary}`, timestamp: message.timestamp });
      continue;
    }
    if (message.role === "assistant") {
      if (!Array.isArray(message.content)) continue;
      const content = message.content.filter((part) => {
        if (part.type !== "toolCall") return true;
        if (["bg", "subagent"].includes(part.name) || !resultIds.has(part.id)) return false;
        callIds.add(part.id);
        return true;
      });
      if (content.length) sanitized.push({
        ...message,
        content,
        usage: {
          ...message.usage,
          input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, reasoning: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      });
      continue;
    }
    if (message.role === "toolResult") {
      if (callIds.has(message.toolCallId)) sanitized.push({ ...message, usage: undefined });
      continue;
    }
    sanitized.push(message);
  }
  return sanitized;
}

function processIsAlive(pid?: number) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireSessionLock(sessionId: string) {
  if (!/^[a-zA-Z0-9-]+$/.test(sessionId)) throw new Error(`Invalid subagent session ID: ${sessionId}`);
  mkdirSync(SUBAGENT_LOCKS, { recursive: true, mode: 0o700 });
  const lock = join(SUBAGENT_LOCKS, sessionId);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(lock, { mode: 0o700 });
      writeFileSync(join(lock, "owner"), String(process.pid), { mode: 0o600 });
      return lock;
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      try {
        const owner = Number(readFileSync(join(lock, "owner"), "utf8"));
        if (processIsAlive(owner)) throw new Error(`Subagent session ${sessionId} is already running in process ${owner}`);
        const stale = `${lock}.stale-${randomUUID()}`;
        renameSync(lock, stale);
        rmSync(stale, { recursive: true, force: true });
      } catch (staleError: any) {
        if (staleError?.code !== "ENOENT") throw staleError;
      }
    }
  }
  throw new Error(`Could not acquire subagent session lock: ${sessionId}`);
}

function getSubagentHeading(error?: string, timedOut = false, cancelled = false) {
  return timedOut ? "Background subagent timed out" : cancelled ? "Background subagent was stopped" : error ? "Background subagent failed" : "Background subagent finished";
}

export default function (pi: ExtensionAPI) {
  const jobs = new Map<number, BgJob>();
  let nextVirtualPid = -1;
  let modelRuntime: Promise<ModelRuntime> | undefined;
  let currentCtx: ExtensionContext | undefined;
  let generation = 0;
  let shuttingDown = true;
  let lifecycle = new AbortController();
  const pending = new Set<Promise<void>>();

  for (const record of Object.values(readIndex())) {
    if (record.state === "running" && !processIsAlive(record.ownerPid)) {
      record.state = "interrupted";
      record.updatedAt = new Date().toISOString();
      saveRecord(record);
    }
  }

  const BRAILLE = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let widgetTimer: ReturnType<typeof setInterval> | undefined;

  function syncStatus(ctx?: ExtensionContext) {
    if (shuttingDown) return;
    const active = currentCtx ?? ctx;
    if (!active) return;

    const activeJobs = Array.from(jobs.values());
    if (activeJobs.length === 0) {
      active.ui.setWidget("bg-subagents", undefined);
      if (widgetTimer) {
        clearInterval(widgetTimer);
        widgetTimer = undefined;
      }
      return;
    }

    active.ui.setWidget("bg-subagents", (_tui, theme) => {
      const frame = BRAILLE[Math.floor(Date.now() / 100) % BRAILLE.length];
      const bColor = (str: string) => theme.fg("dim", str);
      return {
        render(width: number) {
          const count = activeJobs.length;
          const innerWidth = Math.max(10, width - 2);
          const title = ` Background Jobs (${count}) `;
          const rightHint = " /bg ";
          const topFillLen = Math.max(0, innerWidth - visibleWidth(title) - visibleWidth(rightHint));
          const top = bColor("╭") + theme.fg("accent", theme.bold(title)) + bColor("─".repeat(topFillLen)) + bColor(rightHint + "╮");

          const maxVisible = 3;
          const overflow = count > maxVisible;
          const visibleJobs = activeJobs.slice(0, overflow ? 2 : 3);

          const jobLines = visibleJobs.map((job) => {
            const elapsed = Math.round((Date.now() - job.startedAt) / 1000);
            const icon = theme.fg("accent", frame);
            const progress = job.activity ? `, ${job.activity}` : "";
            const badgeText = job.session?.model ? `${job.session.model.id}:${job.session.thinkingLevel}` : job.badge;
            const badge = badgeText ? ` [${badgeText}]` : "";
            const content = ` ${icon} ${job.command}${badge} ${theme.fg("dim", `(running, ${elapsed}s${progress})`)}`;
            const fill = " ".repeat(Math.max(0, innerWidth - visibleWidth(content)));
            return bColor("│") + truncateToWidth(content + fill, innerWidth) + bColor("│");
          });

          if (overflow) {
            const hidden = count - 2;
            const content = ` ${theme.fg("accent", frame)} ${theme.fg("dim", `+${hidden} more running...`)}`;
            const fill = " ".repeat(Math.max(0, innerWidth - visibleWidth(content)));
            jobLines.push(bColor("│") + truncateToWidth(content + fill, innerWidth) + bColor("│"));
          }

          const bottom = bColor("╰" + "─".repeat(innerWidth) + "╯");
          return [truncateToWidth(top, width), ...jobLines, truncateToWidth(bottom, width)];
        },
        invalidate() {},
      };
    }, { placement: "aboveEditor" });

    if (!widgetTimer) {
      widgetTimer = setInterval(() => syncStatus(), 100);
    }
  }

  function guard(expectedGeneration: number) {
    if (shuttingDown || generation !== expectedGeneration || lifecycle.signal.aborted) throw new Error("Parent session ended during background setup");
  }

  function track(done: Promise<void>) {
    pending.add(done);
    void done.then(() => pending.delete(done), () => pending.delete(done));
    return done;
  }

  function deliverCompletion(message: string, ctx: ExtensionContext | undefined, completion: "queue" | "continue", expectedGeneration: number) {
    if (shuttingDown || generation !== expectedGeneration) return;
    const active = currentCtx;
    if (!active) return;
    pi.sendMessage(
      { customType: "pi-bg-result", content: message, display: true },
      completion === "queue" ? { deliverAs: "nextTurn" } : { deliverAs: "steer", triggerTurn: active.isIdle() },
    );
  }

  function killJob(pid: number): boolean {
    const job = jobs.get(pid);
    if (!job) return false;
    job.controller.abort();
    // Jobs are deleted in their own finish/finalize path once abort resolves
    return true;
  }

  function resolveSubagentCwd(parent: string, requested?: string) {
    const root = realpathSync(parent);
    const target = realpathSync(resolve(root, requested?.trim() || "."));
    const rel = relative(root, target);
    if (rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) {
      throw new Error(`cwd must be inside the parent project; use worktree:true for isolated external work: ${target}`);
    }
    if (!statSync(target).isDirectory()) throw new Error(`cwd is not a directory: ${target}`);
    return target;
  }

  function runBgProcess(command: string, timeoutSec: number, ctx: ExtensionContext, completion: "queue" | "continue" = "continue") {
    const expectedGeneration = generation;
    const shownCommand = command.length > 120 ? `${command.slice(0, 117)}...` : command;
    const pid = nextVirtualPid--;
    const controller = new AbortController();
    let output = "";
    let outputTruncated = false;
    const job: BgJob = { pid, command: shownCommand, startedAt: Date.now(), controller, kind: "shell" };
    jobs.set(pid, job);
    syncStatus(ctx);

    job.done = track(createLocalBashOperations().exec(command, ctx.cwd, {
      signal: controller.signal,
      timeout: timeoutSec,
      onData(data) {
        const truncated = truncateTail(output + data.toString());
        outputTruncated ||= truncated.truncated;
        output = truncated.content;
      },
    }).then(({ exitCode }) => finish(exitCode)).catch((error) => finish(null, error)));

    function finish(exitCode: number | null, error?: unknown) {
      const message = error instanceof Error ? error.message : error ? String(error) : "";
      const timedOut = message.startsWith("timeout:");
      const cancelled = controller.signal.aborted && !timedOut;
      const failed = Boolean(error) && !cancelled && !timedOut;
      const content = output.trim();
      const keepLog = cancelled || timedOut || failed || exitCode !== 0 || outputTruncated;
      const logFile = keepLog ? join(getLogDir(), `${randomUUID()}.log`) : "";
      if (keepLog) {
        try { writeFileSync(logFile, content || message, { mode: 0o600 }); }
        catch (logError) { console.warn(`Could not save background task log:`, logError); }
      }
      const heading = timedOut ? `Background task timed out after ${timeoutSec} seconds`
        : cancelled ? "Background task was stopped"
        : failed ? "Background task could not start"
        : exitCode === 0 ? "Background task finished" : "Background task failed";
      const result = content ? `\n\nResult:\n${content}${outputTruncated ? `\n\nThe result was shortened. Retained tail: ${logFile}` : ""}` : "";
      const reason = failed ? `\n\nReason: ${message}` : exitCode ? `\n\nExit code: ${exitCode}` : "";
      deliverCompletion(
        `${heading}\nTask: ${shownCommand}${reason}${result}${keepLog ? `\n\nTroubleshooting log: ${logFile}` : ""}`,
        ctx,
        completion,
        expectedGeneration,
      );
      jobs.delete(pid);
      syncStatus(ctx);
    }

    return {
      content: [{ type: "text" as const, text: `Started shell job ${pid}: ${shownCommand}\nThe result will arrive automatically. Continue other work; do not wait, sleep, or poll. Use /bg to view or stop the task.` }],
      details: { pid },
    };
  }

  pi.on("session_start", (_e, ctx) => {
    generation++;
    shuttingDown = false;
    lifecycle = new AbortController();
    currentCtx = ctx;
    syncStatus(ctx);
  });

  pi.on("session_shutdown", async () => {
    shuttingDown = true;
    lifecycle.abort();
    if (widgetTimer) clearInterval(widgetTimer);
    for (const [pid, job] of jobs) {
      try {
        if (job.record) {
          job.record = { ...currentRecord(job), state: "interrupted", updatedAt: new Date().toISOString(), durationSec: Math.round((Date.now() - job.startedAt) / 1000) };
          saveRecord(job.record);
        }
      } catch (error) {
        console.warn(`Could not persist interrupted background job ${pid}:`, error);
      } finally {
        killJob(pid);
      }
    }
    await Promise.race([
      Promise.allSettled([...pending]),
      new Promise((resolve) => setTimeout(resolve, 1000)),
    ]);
    currentCtx = undefined;
  });

  async function manageJobs(ctx: ExtensionContext) {
    if (jobs.size === 0) return ctx.ui.notify("No background jobs running", "info");
    const choice = await ctx.ui.select("Select job to stop:", [
      "Cancel",
      ...Array.from(jobs.values(), (job) =>
        `[${job.pid}] ${job.command}${job.sessionId ? ` [session: ${job.sessionId.slice(0, 8)}]` : ""} (${Math.round((Date.now() - job.startedAt) / 1000)}s)`
      ),
    ]);
    const pid = Number(choice?.match(/\[(-?\d+)\]/)?.[1]);
    if (choice !== "Cancel" && Number.isInteger(pid) && killJob(pid)) {
      ctx.ui.notify(`Stopped background job ${pid}`, "info");
      syncStatus(ctx);
    }
  }

  pi.registerCommand("bg", {
    description: "List and manage background jobs",
    getArgumentCompletions: (prefix) => {
      const items = Array.from(jobs.values(), (job) => ({ value: `kill ${job.pid}`, label: `kill ${job.pid}`, description: job.command }))
        .filter((item) => item.value.startsWith(prefix));
      return items.length ? items : null;
    },
    handler: async (args, ctx) => {
      currentCtx = ctx;
      const trimmed = args?.trim() ?? "";
      const killMatch = trimmed.match(/^(?:kill\s+)?(-?\d+)$/);
      if (killMatch) {
        const pid = Number(killMatch[1]);
        if (killJob(pid)) {
          ctx.ui.notify(`Killed background job ${pid}`, "info");
          syncStatus(ctx);
        } else {
          ctx.ui.notify(`No background job found with ID ${pid}`, "error");
        }
        return;
      }
      if (trimmed.startsWith("kill")) {
        ctx.ui.notify("Usage: /bg kill <pid>", "error");
        return;
      }

      if (ctx.hasUI) await manageJobs(ctx);
    },
  });

  pi.registerTool({
    name: "bg",
    label: "Background",
    description: "Run, inspect, or stop long-running shell commands without blocking the agent session.",
    promptSnippet: "Run, inspect, or stop long-running shell commands without blocking the agent session.",
    promptGuidelines: [
      "Use bg for long-running processes (e.g. dev servers, builds, test suites, heavy installs, long background tasks) or when the user asks to run commands while continuing discussion.",
      "Use standard bash for quick commands with immediate output (e.g. ls, git status, file reads).",
      "After starting bg, continue work immediately; never wait, sleep, or poll for completion.",
    ],
    parameters: Type.Object({
      action: Type.Optional(StringEnum(["spawn", "status", "stop"] as const, { description: "Action (default: spawn)" })),
      command: Type.Optional(Type.String({ description: "Shell command for spawn" })),
      completion: Type.Optional(StringEnum(["queue", "continue"] as const, { description: "continue wakes the parent turn automatically when ready (default); queue waits for user's next prompt" })),
      pid: Type.Optional(Type.Number({ description: "Job ID for stop" })),
      timeoutSec: Type.Optional(Type.Number({ minimum: 1, maximum: 2_147_483, description: "Timeout in seconds (default: 600)" })),
    }),
    async execute(id, { action = "spawn", command, completion = "continue", pid, timeoutSec = 600 }, _sig, _up, ctx) {
      currentCtx = ctx;
      if (action === "status") {
        const listed = Array.from(jobs.values()).filter((job) => job.kind === "shell");
        const text = listed.map((job) => `${job.pid} running ${job.command} (${Math.round((Date.now() - job.startedAt) / 1000)}s)`);
        return { content: [{ type: "text" as const, text: text.join("\n") || "No shell jobs." }], details: {} };
      }
      const job = pid === undefined ? undefined : jobs.get(pid);
      if (action === "stop") {
        if (!job || job.kind !== "shell") throw new Error(`Shell job not found: ${pid ?? "missing pid"}`);
        job.controller.abort();
        return { content: [{ type: "text" as const, text: `Stopped shell job ${pid}` }], details: { pid } };
      }
      if (!command?.trim()) throw new Error("command is required for spawn");
      return runBgProcess(command.trim(), timeoutSec, ctx, completion);
    },
  });

  function currentRecord(job: BgJob): SubagentRecord {
    const stats = job.session!.getSessionStats();
    return {
      ...job.record!,
      ...(job.session?.model ? { model: `${job.session.model.provider}/${job.session.model.id}`, thinking: job.session.thinkingLevel } : {}),
      turns: stats.assistantMessages - job.baseline!.assistantMessages,
      toolCount: stats.toolCalls - job.baseline!.toolCalls,
      toolFailures: job.toolFailures ?? 0,
      usage: usageSince(stats, job.baseline!),
    };
  }

  function statusDetails(record: SubagentRecord, job?: BgJob) {
    const current = job ? currentRecord(job) : record;
    const { ownerPid: _, ...details } = current;
    return {
      ...details,
      ...(job?.activity ? { activity: job.activity } : {}),
      ...(job ? { elapsedSec: Math.round((Date.now() - job.startedAt) / 1000) } : {}),
    };
  }

  function statusText(item: ReturnType<typeof statusDetails>) {
    const usage = item.usage;
    const timing = item.elapsedSec !== undefined ? `${item.elapsedSec}s elapsed` : item.durationSec !== undefined ? `${item.durationSec}s` : "duration unavailable";
    return `${item.sessionId} ${item.state} ${JSON.stringify(item.label)} | ${item.model}:${item.thinking} | ${item.cwd} | activity:${item.activity ?? "-"} | inherited:[${item.inheritedTools.join(",")}] turns:${item.turns} tools:${item.toolCount} failures:${item.toolFailures} | in:${usage.input} out:${usage.output} R:${usage.cacheRead} W:${usage.cacheWrite} $${usage.cost.toFixed(4)} | ${timing} | ${item.sessionFile}${item.branch ? ` | branch:${item.branch}` : ""}`;
  }

  async function createWorktree(ctx: ExtensionContext, signal?: AbortSignal) {
    const rootResult = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd: ctx.cwd, signal });
    if (rootResult.code !== 0) throw new Error(`worktree:true requires a Git worktree: ${rootResult.stderr.trim() || ctx.cwd}`);
    const root = realpathSync(rootResult.stdout.trim());
    const id = randomUUID().slice(0, 8);
    const branch = `pi-background-agents/${Date.now()}-${id}`;
    mkdirSync(SUBAGENT_WORKTREES, { recursive: true, mode: 0o700 });
    const path = join(SUBAGENT_WORKTREES, `${basename(root)}-${id}`);
    const result = await pi.exec("git", ["-c", "core.hooksPath=/dev/null", "worktree", "add", "-b", branch, path], { cwd: root, signal });
    if (result.code !== 0) throw new Error(`Could not create worktree: ${result.stderr.trim() || result.stdout.trim()}`);
    return { branch, path: realpathSync(path) };
  }

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: "Delegate complex, isolated, or deep exploration tasks to a background subagent.",
    promptSnippet: "Delegate complex, isolated, or deep exploration tasks to a background subagent.",
    promptGuidelines: [
      "Use subagent for multi-step sub-tasks, background research, code audits, refactoring, or sub-problems to keep main context uncluttered.",
      "Provide complete and self-contained instructions in prompt; use context:fork only when the child needs the parent's current conversation.",
      "Reuse sessionId from an earlier subagent result to continue its saved model, thinking level, cwd, and conversation.",
      "For high-level or non-technical requests ('check performance', 'audit security', 'investigate codebase'), delegate isolated sub-tasks to subagent.",
      "For independent tasks, call subagent multiple times in one turn; Pi runs them concurrently.",
      "Use worktree:true for concurrent writing subagents; pi-background-agents creates but never merges or removes the branch/worktree.",
      "After starting subagent, continue work immediately; never wait, sleep, or poll action:status for completion. Results arrive automatically.",
    ],
    parameters: Type.Object({
      action: Type.Optional(StringEnum(["spawn", "status", "steer", "stop"] as const, { description: "Action (default: spawn)" })),
      prompt: Type.Optional(Type.String({ description: "Task for spawn" })),
      description: Type.Optional(Type.String({ description: "Short job label" })),
      sessionId: Type.Optional(Type.String({ description: "Durable session identity to resume, inspect, steer, or stop" })),
      message: Type.Optional(Type.String({ description: "Message queued after the running child's current turn" })),
      completion: Type.Optional(StringEnum(["queue", "continue"] as const, { description: "continue wakes the parent turn automatically when ready (default); queue waits for user's next prompt" })),
      model: Type.Optional(Type.String({ description: "Preferred model; omitted on resume to restore the saved model" })),
      thinking: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const, { description: "Thinking level; omitted on resume to restore the saved level" })),
      tools: Type.Optional(Type.String({ description: "Comma-separated tool allowlist; can only narrow the parent's active tools" })),
      cwd: Type.Optional(Type.String({ description: "Existing working directory; cannot be combined with worktree:true" })),
      worktree: Type.Optional(Type.Boolean({ description: "Create a unique persistent Git branch/worktree for a new session" })),
      context: Type.Optional(StringEnum(["project", "fork"] as const, { description: "project starts fresh with project resources (default); fork seeds sanitized parent conversation" })),
      timeoutSec: Type.Optional(Type.Number({ minimum: 1, maximum: 2_147_483, description: "Timeout in seconds (default: 600)" })),
    }),
    async execute(_id, { action = "spawn", prompt, description, sessionId, message, completion = "continue", model, thinking, tools, cwd, worktree = false, context = "project", timeoutSec = 600 }, signal, _up, ctx) {
      currentCtx = ctx;
      const requestedId = sessionId?.trim();
      const matching = requestedId ? Array.from(jobs.values()).find((job) => job.kind === "subagent" && job.sessionId === requestedId) : undefined;
      if (action === "status") {
        const active = new Map(Array.from(jobs.values()).filter((job) => job.kind === "subagent" && job.record).map((job) => [job.sessionId!, job]));
        const durable = readIndex();
        const records = requestedId
          ? (active.get(requestedId)?.record || durable[requestedId] ? [active.get(requestedId)?.record ?? durable[requestedId]] : [])
          : [...Array.from(active.values(), (job) => job.record!), ...Object.values(durable).filter((record) => !active.has(record.sessionId)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 50)];
        const sessions = records.map((record) => statusDetails(record, active.get(record.sessionId)));
        return { content: [{ type: "text" as const, text: sessions.map(statusText).join("\n") || "No matching subagent sessions." }], details: { sessions } };
      }
      if (action === "stop") {
        if (!matching) throw new Error(`Running subagent not found: ${requestedId || "missing sessionId"}`);
        killJob(matching.pid);
        syncStatus(ctx);
        return { content: [{ type: "text" as const, text: `Stopping subagent ${matching.sessionId}` }], details: { sessionId: matching.sessionId } };
      }
      if (action === "steer") {
        if (!matching?.session) throw new Error(`Running subagent not found: ${requestedId || "missing sessionId"}`);
        if (!message?.trim()) throw new Error("message is required for steer");
        await matching.session.steer(message.trim());
        return { content: [{ type: "text" as const, text: `Queued steering for subagent ${matching.sessionId} after its current turn` }], details: { sessionId: matching.sessionId, queued: true } };
      }
      if (!prompt?.trim()) throw new Error("prompt is required for spawn");
      const expectedGeneration = generation;
      guard(expectedGeneration);
      const setupSignal = AbortSignal.any([...(signal ? [signal] : []), lifecycle.signal]);
      const checkSetup = () => {
        guard(expectedGeneration);
        if (setupSignal.aborted) throw new Error("Subagent setup was cancelled");
      };
      prompt = prompt.trim();
      if (requestedId && matching) throw new Error(`Subagent session ${requestedId} is already running`);
      if (worktree && cwd !== undefined) throw new Error("cwd cannot be combined with worktree:true");
      if (requestedId && worktree) throw new Error("worktree:true is only valid for a new subagent session");
      if (requestedId && context === "fork") throw new Error("context:fork is only valid for a new subagent session");

      const existing = requestedId ? readIndex()[requestedId] : undefined;
      if (requestedId && !existing) throw new Error(`Subagent session not found in ${SUBAGENT_INDEX}: ${requestedId}`);
      if (existing && (!existsSync(existing.cwd) || !statSync(existing.cwd).isDirectory())) {
        throw new Error(`Cannot resume subagent ${requestedId}: saved cwd${existing.branch ? "/worktree" : ""} is missing or deleted: ${existing.cwd}`);
      }
      if (existing && !existsSync(existing.sessionFile)) throw new Error(`Cannot resume subagent ${requestedId}: session file is missing or deleted: ${existing.sessionFile}`);

      let branch: string | undefined;
      let childCwd: string;
      if (existing) {
        childCwd = realpathSync(existing.cwd);
        if (cwd && resolveSubagentCwd(ctx.cwd, cwd) !== childCwd) throw new Error(`cwd does not match the saved subagent cwd: ${childCwd}`);
        branch = existing.branch;
      } else if (worktree) {
        const created = await createWorktree(ctx, setupSignal);
        childCwd = created.path;
        branch = created.branch;
        checkSetup();
      } else {
        childCwd = resolveSubagentCwd(ctx.cwd, cwd);
      }

      modelRuntime ??= ModelRuntime.create();
      const runtime = await modelRuntime;
      checkSetup();
      for (const providerId of ctx.modelRegistry.getRegisteredProviderIds()) {
        const native = ctx.modelRegistry.getRegisteredNativeProvider(providerId);
        const config = ctx.modelRegistry.getRegisteredProviderConfig(providerId);
        if (native) runtime.registerNativeProvider(native);
        else if (config) runtime.registerProvider(providerId, config);
      }
      const modelSpec = model?.trim();
      const resolved = modelSpec ? resolveCliModel({ cliModel: modelSpec, cliThinking: thinking, modelRuntime: runtime }) : undefined;
      if (resolved?.error) throw new Error(resolved.error);
      if (resolved?.warning) console.warn(resolved.warning);

      const parentTools = pi.getActiveTools().filter((name) => name !== "bg" && name !== "subagent");
      const requestedTools = tools?.split(",").map((tool) => tool.trim()).filter(Boolean);
      const unknownTools = requestedTools?.filter((tool) => !parentTools.includes(tool)) ?? [];
      if (unknownTools.length) throw new Error(`Tools are not active in the parent session: ${unknownTools.join(", ")}`);
      const childTools = requestedTools ?? parentTools;

      mkdirSync(SUBAGENT_SESSION_DIR, { recursive: true, mode: 0o700 });
      const sessionManager = existing
        ? SessionManager.open(existing.sessionFile, SUBAGENT_SESSION_DIR, childCwd)
        : SessionManager.create(childCwd, SUBAGENT_SESSION_DIR, context === "fork" ? { parentSession: ctx.sessionManager.getSessionFile() } : undefined);
      if (!existing && context === "fork") for (const parentMessage of sanitizeForkMessages(ctx)) sessionManager.appendMessage(parentMessage);
      const requestedThinking = thinking ?? resolved?.thinkingLevel;
      const selectedModel = resolved?.model ?? (!existing ? ctx.model : undefined);
      if (selectedModel) {
        const runtimeKey = await ctx.modelRegistry.getApiKeyForProvider(selectedModel.provider);
        checkSetup();
        if (runtimeKey) runtime.setRuntimeApiKey(selectedModel.provider, runtimeKey);
      }
      let sessionLock = existing ? acquireSessionLock(existing.sessionId) : undefined;
      let created: Awaited<ReturnType<typeof createAgentSession>>;
      try {
        created = await createAgentSession({
          cwd: childCwd,
          tools: childTools,
          excludeTools: ["bg", "subagent"],
          modelRuntime: runtime,
          sessionManager,
          ...(selectedModel ? { model: selectedModel } : {}),
          ...(!existing ? { thinkingLevel: requestedThinking ?? ctx.thinkingLevel } : requestedThinking ? { thinkingLevel: requestedThinking } : {}),
        });
        checkSetup();
        sessionLock ??= acquireSessionLock(created.session.sessionId);
      } catch (error) {
        if (sessionLock) rmSync(sessionLock, { recursive: true, force: true });
        throw error;
      }
      const { session, modelFallbackMessage, extensionsResult } = created;
      const controller = new AbortController();
      let extensionsBound = false;
      let disposed = false;
      const disposeChild = async () => {
        if (disposed) return;
        disposed = true;
        if (extensionsBound) {
          try {
            await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
          } catch {}
        }
        session.dispose();
        if (sessionLock) rmSync(sessionLock, { recursive: true, force: true });
      };
      try {
        checkSetup();
        extensionsBound = true;
        await session.bindExtensions({
          mode: "print",
          abortHandler: () => void session.abort(),
          shutdownHandler: () => controller.abort(),
          onError: (error) => console.warn(`Subagent extension error: ${error.error}`),
        });
        checkSetup();
        if (controller.signal.aborted) throw new Error("Subagent extension requested shutdown during setup");
        for (const error of extensionsResult.errors) console.warn(`Subagent extension failed to load ${error.path}: ${error.error}`);
      } catch (error) {
        await disposeChild();
        throw error;
      }

      if (!session.model) {
        await disposeChild();
        throw new Error("Subagent session did not initialize a model");
      }
      const actualTools = session.getActiveToolNames().filter((name) => name !== "bg" && name !== "subagent");
      const missingTools = requestedTools?.filter((name) => !actualTools.includes(name)) ?? [];
      if (missingTools.length) {
        await disposeChild();
        throw new Error(`Requested tools were not available in the child: ${missingTools.join(", ")}`);
      }
      if (!existing) {
        sessionManager.appendCustomEntry("pi-background-agents", { createdAt: new Date().toISOString() });
        if (context === "fork") sessionManager.appendModelChange(session.model.provider, session.model.id);
      }
      const sessionFile = session.sessionFile ?? sessionManager.getSessionFile();
      if (!sessionFile) {
        await disposeChild();
        throw new Error("Subagent session did not initialize a persistent session path");
      }

      const pid = nextVirtualPid--;
      let timedOut = false;
      let cancelled = false;
      let partialAssistant: any;
      const runAssistants: any[] = [];
      controller.signal.addEventListener("abort", () => {
        cancelled = !timedOut;
        void session.abort();
      }, { once: true });
      const label = description?.trim() || (prompt.length > 30 ? `${prompt.slice(0, 30)}...` : prompt);
      const displayModel = `${session.model.provider}/${session.model.id}`;
      const now = new Date().toISOString();
      const record: SubagentRecord = {
        sessionId: session.sessionId,
        cwd: childCwd,
        sessionFile,
        model: displayModel,
        thinking: session.thinkingLevel,
        label,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        state: "running",
        turns: 0,
        toolCount: 0,
        toolFailures: 0,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 },
        inheritedTools: actualTools,
        branch,
        context: existing?.context ?? context,
        modelFallback: modelFallbackMessage,
        ownerPid: process.pid,
      };
      const job: BgJob = {
        pid, command: `Subagent: ${label}`, startedAt: Date.now(), sessionId: session.sessionId,
        controller, kind: "subagent", session, activity: "starting", badge: `${session.model.id}:${session.thinkingLevel}`,
        baseline: session.getSessionStats(), record, toolFailures: 0, activeTools: new Map(), sessionLock,
      };
      try {
        jobs.set(pid, job);
        saveRecord(record);
      } catch (error) {
        jobs.delete(pid);
        await disposeChild();
        throw error;
      }

      const setActivity = (activity: string) => {
        if (job.activity === activity) return;
        job.activity = activity;
        syncStatus(ctx);
      };
      const unsubscribe = session.subscribe((event) => {
        if (event.type === "message_update" && event.message.role === "assistant") partialAssistant = event.message;
        if (event.type === "message_end" && event.message.role === "assistant") runAssistants.push(event.message);
        if (event.type === "turn_start") setActivity("thinking");
        else if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta" && !job.activeTools!.size) setActivity("responding");
        else if (event.type === "tool_execution_start") {
          job.activeTools!.set(event.toolCallId, event.toolName);
          setActivity(`tool: ${[...job.activeTools!.values()].join(", ")}`);
        } else if (event.type === "tool_execution_end") {
          job.activeTools!.delete(event.toolCallId);
          if (event.isError) job.toolFailures!++;
          setActivity(job.activeTools!.size ? `tool: ${[...job.activeTools!.values()].join(", ")}` : event.isError ? `tool failed: ${event.toolName}` : "thinking");
        }
      });
      syncStatus(ctx);
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutSec * 1000);
      const operation = existing ? "continued" : "created";
      const done = (async () => {
        try {
          let thrown: string | undefined;
          try {
            await session.prompt(prompt);
          } catch (error) {
            thrown = error instanceof Error ? error.message : String(error);
          }
          const assistant = runAssistants.at(-1) ?? partialAssistant;
          const stopped = cancelled || assistant?.stopReason === "aborted";
          const failed = Boolean(thrown || assistant?.errorMessage || assistant?.stopReason === "error");
          const state: TerminalState = timedOut ? "timed-out" : stopped ? "stopped" : failed ? "failed" : "finished";
          let reason = thrown ?? assistant?.errorMessage;
          const rawText = Array.isArray(assistant?.content)
            ? assistant.content.filter((part: any) => part?.type === "text" && typeof part.text === "string").map((part: any) => part.text).join("\n").trim()
            : "";
          const truncated = truncateTail(rawText);
          let truncationNote = "";
          if (truncated.truncated) {
            const logFile = join(getLogDir(), `${randomUUID()}.log`);
            try {
              writeFileSync(logFile, rawText, { mode: 0o600 });
              truncationNote = `\n\nResult truncated; full output: ${logFile}`;
            } catch (logError) {
              console.warn(`Could not save full subagent output:`, logError);
              truncationNote = "\n\nResult truncated; full output remains in the durable session file.";
            }
          }
          if (!shuttingDown && generation === expectedGeneration) {
            job.record = {
              ...currentRecord(job),
              state,
              durationSec: Math.round((Date.now() - job.startedAt) / 1000),
              updatedAt: new Date().toISOString(),
            };
            try { saveRecord(job.record); }
            catch (recordError) {
              console.warn(`Could not save final subagent state:`, recordError);
              reason ??= `Could not save final subagent state: ${recordError instanceof Error ? recordError.message : String(recordError)}`;
            }
          }
          const completedRecord = job.record;
          if (!completedRecord) throw new Error(`Missing durable record for subagent ${session.sessionId}`);
          const usage = completedRecord.usage;
          const telemetry = `\n\nSubagent: ${operation} session:${session.sessionId} model:${displayModel}:${session.thinkingLevel} cwd:${childCwd} turns:${completedRecord.turns} tools:${completedRecord.toolCount} failures:${completedRecord.toolFailures} duration:${completedRecord.durationSec}s sessionFile:${sessionFile}`;
          const usageText = `\nUsage: in:${usage.input} out:${usage.output} R:${usage.cacheRead} W:${usage.cacheWrite} total:${usage.total} cost:$${usage.cost.toFixed(4)}`;
          const recovery = state === "finished" ? "" : `\n\nSession ${session.sessionId} is saved and can be resumed with subagent spawn(sessionId: "${session.sessionId}", prompt: "...").`;
          const fallback = modelFallbackMessage ? `\nModel fallback: ${modelFallbackMessage}` : "";
          deliverCompletion(`${getSubagentHeading(reason || (failed ? "failed" : undefined), timedOut, stopped)}\nTask: Subagent: ${label}${truncated.content ? `\n\nResult:\n${truncated.content}` : ""}${truncationNote}${reason ? `\n\nReason: ${reason}` : ""}${recovery}${telemetry}${usageText}${fallback}`, ctx, completion, expectedGeneration);
        } finally {
          clearTimeout(timer);
          unsubscribe();
          jobs.delete(pid);
          await disposeChild();
          syncStatus(ctx);
        }
      })();
      job.done = track(done);

      const location = branch ? `\nBranch: ${branch}\nWorktree: ${childCwd}` : "";
      const fallback = modelFallbackMessage ? `\nModel fallback: ${modelFallbackMessage}` : "";
      return {
        content: [{ type: "text", text: `${existing ? "Continued" : "Created"}: Subagent: ${label}\nThe result will arrive automatically. Continue other work; do not wait, sleep, or poll. Use subagent status or /bg to inspect or stop it.\nSession: ${session.sessionId}\nModel: ${displayModel}:${session.thinkingLevel}\nCwd: ${childCwd}\nTools: ${actualTools.join(", ")}\nContext: ${record.context}${location}${fallback}` }],
        details: { pid, sessionId: session.sessionId, sessionFile, model: displayModel, thinking: session.thinkingLevel, cwd: childCwd, inheritedTools: actualTools, context: record.context, state: record.state, continued: Boolean(existing), ...(branch ? { branch } : {}), ...(modelFallbackMessage ? { modelFallback: modelFallbackMessage } : {}) },
      };
    },
  });
}
