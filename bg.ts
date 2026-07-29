import { createAgentSession, createLocalBashOperations, ModelRuntime, resolveCliModel, SessionManager, truncateTail } from "@earendil-works/pi-coding-agent";
import type { AgentSession, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

const LOG_DIR = join(tmpdir(), "pi-bg", String(process.pid));
const SUBAGENT_SESSION_DIR = join(LOG_DIR, "sessions");

interface BgJob {
  pid: number;
  command: string;
  startedAt: number;
  sessionId?: string;
  controller: AbortController;
  kind: "shell" | "subagent";
  state: "queued" | "running";
  session?: AgentSession;
  writer?: boolean;
  start?: () => void;
}

function getSubagentHeading(error?: string, timedOut = false, cancelled = false) {
  return timedOut ? "Background subagent timed out" : cancelled ? "Background subagent was stopped" : error ? "Background subagent failed" : "Background subagent finished";
}

export default function (pi: ExtensionAPI) {
  const jobs = new Map<number, BgJob>();
  let nextVirtualPid = -1;
  let modelRuntime: Promise<ModelRuntime> | undefined;
  let activeSubagents = 0;
  let activeWriters = 0;
  const subagentQueue: BgJob[] = [];
  const pumpSubagents = () => {
    while (activeSubagents < 4) {
      const index = subagentQueue.findIndex((queued) => !queued.writer || activeWriters === 0);
      if (index < 0) return;
      subagentQueue.splice(index, 1)[0].start?.();
    }
  };

  let currentCtx: ExtensionContext | undefined;

  function getActiveCtx(ctx?: ExtensionContext): ExtensionContext | undefined {
    if (ctx) {
      try {
        void ctx.hasUI;
        return ctx;
      } catch {
        // Context is stale after session replacement or reload
      }
    }
    if (currentCtx) {
      try {
        void currentCtx.hasUI;
        return currentCtx;
      } catch {
        // Context is stale after session replacement or reload
      }
    }
    return undefined;
  }

  const BRAILLE = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let widgetTimer: ReturnType<typeof setInterval> | undefined;

  function syncStatus(ctx?: ExtensionContext) {
    const active = getActiveCtx(ctx);
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
      const suffix = theme.fg("dim", " · /bg");
      return {
        render(width: number) {
          const renderJob = (job: BgJob) => {
            const elapsed = Math.round((Date.now() - job.startedAt) / 1000);
            const icon = job.state === "queued" ? theme.fg("warning", "·") : theme.fg("accent", frame);
            return truncateToWidth(`${icon} ${job.command} ${theme.fg("dim", `(${job.state}, ${elapsed}s)`)}${suffix}`, width);
          };

          const overflow = activeJobs.length > 3;
          const lines = activeJobs.slice(0, overflow ? 2 : 3).map(renderJob);
          if (overflow) {
            lines.push(truncateToWidth(`${theme.fg("accent", frame)} ${theme.fg("dim", `+${activeJobs.length - 2} more running`)}${suffix}`, width));
          }
          return lines;
        },
        invalidate() {},
      };
    }, { placement: "aboveEditor" });

    if (!widgetTimer) {
      widgetTimer = setInterval(() => syncStatus(ctx), 100);
    }
  }

  function deliverCompletion(message: string, ctx: ExtensionContext | undefined, completion: "queue" | "continue") {
    const active = getActiveCtx(ctx);
    pi.sendMessage(
      { customType: "pi-bg-result", content: message, display: true },
      completion === "queue" ? { deliverAs: "nextTurn" } : { deliverAs: "steer", triggerTurn: active?.isIdle() ?? false },
    );
  }

  function killJob(pid: number): boolean {
    const job = jobs.get(pid);
    if (!job) return false;
    job.controller.abort();
    if (job.state === "queued") {
      const index = subagentQueue.indexOf(job);
      if (index >= 0) subagentQueue.splice(index, 1);
      jobs.delete(pid);
      job.session?.dispose();
      pumpSubagents();
    }
    return true;
  }

  function resolveSubagentCwd(parent: string, requested?: string) {
    const target = resolve(parent, requested?.trim() || ".");
    const rel = relative(realpathSync(parent), realpathSync(target));
    if (rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) {
      throw new Error(`cwd must be inside the parent working directory: ${parent}`);
    }
    if (!statSync(target).isDirectory()) throw new Error(`cwd is not a directory: ${target}`);
    return target;
  }

  function runBgProcess(command: string, timeoutSec: number, ctx: ExtensionContext, completion: "queue" | "continue" = "continue") {
    currentCtx = ctx;
    const shownCommand = command.length > 120 ? `${command.slice(0, 117)}...` : command;
    const pid = nextVirtualPid--;
    const controller = new AbortController();
    let output = "";
    let outputTruncated = false;
    jobs.set(pid, { pid, command: shownCommand, startedAt: Date.now(), controller, kind: "shell", state: "running" });
    syncStatus(ctx);

    void createLocalBashOperations().exec(command, ctx.cwd, {
      signal: controller.signal,
      timeout: timeoutSec,
      onData(data) {
        const truncated = truncateTail(output + data.toString());
        outputTruncated ||= truncated.truncated;
        output = truncated.content;
      },
    }).then(({ exitCode }) => finish(exitCode)).catch((error) => finish(null, error));

    function finish(exitCode: number | null, error?: unknown) {
      const message = error instanceof Error ? error.message : error ? String(error) : "";
      const timedOut = message.startsWith("timeout:");
      const cancelled = controller.signal.aborted && !timedOut;
      const failed = Boolean(error) && !cancelled && !timedOut;
      const content = output.trim();
      const keepLog = cancelled || timedOut || failed || exitCode !== 0 || outputTruncated;
      const logFile = join(LOG_DIR, `${randomUUID()}.log`);
      if (keepLog) {
        mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
        writeFileSync(logFile, content || message, { mode: 0o600 });
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
    currentCtx = ctx;
    syncStatus(ctx);
  });

  pi.on("session_shutdown", () => {
    if (widgetTimer) clearInterval(widgetTimer);
    for (const pid of [...jobs.keys()]) killJob(pid);
  });

  async function manageJobs(ctx: ExtensionContext) {
    const active = getActiveCtx(ctx);
    if (!active?.hasUI) return;
    if (jobs.size === 0) return active.ui.notify("No background jobs running", "info");
    const choice = await active.ui.select("Select job to stop:", [
      "Cancel",
      ...Array.from(jobs.values(), (job) =>
        `[${job.pid}] ${job.state === "queued" ? "queued " : ""}${job.command}${job.sessionId ? ` [session: ${job.sessionId.slice(0, 8)}]` : ""} (${Math.round((Date.now() - job.startedAt) / 1000)}s)`
      ),
    ]);
    const pid = Number(choice?.match(/\[(-?\d+)\]/)?.[1]);
    if (choice !== "Cancel" && Number.isInteger(pid) && killJob(pid)) {
      active.ui.notify(`Stopped background job ${pid}`, "info");
      syncStatus(active);
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
      const active = getActiveCtx(ctx);
      const trimmed = args?.trim() ?? "";
      const killMatch = trimmed.match(/^(?:kill\s+)?(-?\d+)$/);
      if (killMatch) {
        const pid = Number(killMatch[1]);
        if (killJob(pid)) {
          active?.ui.notify(`Killed background job ${pid}`, "info");
          syncStatus(active);
        } else {
          active?.ui.notify(`No background job found with ID ${pid}`, "error");
        }
        return;
      }
      if (trimmed.startsWith("kill")) {
        active?.ui.notify("Usage: /bg kill <pid>", "error");
        return;
      }

      if (active?.hasUI) await manageJobs(active);
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
        const text = listed.map((job) => `${job.pid} ${job.state} ${job.command} (${Math.round((Date.now() - job.startedAt) / 1000)}s)`);
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

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: "Delegate complex, isolated, or deep exploration tasks to a background subagent.",
    promptSnippet: "Delegate complex, isolated, or deep exploration tasks to a background subagent.",
    promptGuidelines: [
      "Use subagent for multi-step sub-tasks, background research, code audits, refactoring, or sub-problems to keep main context uncluttered.",
      "Provide complete and self-contained instructions in prompt so the subagent has full context to complete the task.",
      "Reuse sessionId from an earlier subagent result to continue conversation state with that subagent.",
      "For high-level or non-technical requests ('check performance', 'audit security', 'investigate codebase'), delegate isolated sub-tasks to subagent.",
      "For independent read-only tasks, call subagent multiple times in one turn; Pi runs sibling tool calls in parallel.",
      "Writing subagents are serialized automatically; use read-only tool allowlists for parallel investigation.",
      "After starting subagent, continue work immediately; never wait, sleep, or poll action: status for completion. Results arrive automatically.",
    ],
    parameters: Type.Object({
      action: Type.Optional(StringEnum(["spawn", "status", "steer", "stop"] as const, { description: "Action (default: spawn)" })),
      prompt: Type.Optional(Type.String({ description: "Task for spawn" })),
      description: Type.Optional(Type.String({ description: "Short job label" })),
      sessionId: Type.Optional(Type.String({ description: "Session ID to continue or control" })),
      message: Type.Optional(Type.String({ description: "Steering message" })),
      completion: Type.Optional(StringEnum(["queue", "continue"] as const, { description: "continue wakes the parent turn automatically when ready (default); queue waits for user's next prompt" })),
      model: Type.Optional(Type.String({ description: "Preferred model" })),
      thinking: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const, { description: "Thinking level" })),
      tools: Type.Optional(Type.String({ description: "Comma-separated tool allowlist; can only narrow the parent's tools" })),
      cwd: Type.Optional(Type.String({ description: "Working directory inside the parent project" })),
      timeoutSec: Type.Optional(Type.Number({ minimum: 1, maximum: 2_147_483, description: "Timeout in seconds (default: 600)" })),
    }),
    async execute(_id, { action = "spawn", prompt, description, sessionId, message, completion = "continue", model, thinking, tools, cwd, timeoutSec = 600 }, _sig, _up, ctx) {
      currentCtx = ctx;
      const requestedId = sessionId?.trim();
      const matching = requestedId ? Array.from(jobs.values()).find((job) => job.kind === "subagent" && job.sessionId === requestedId) : undefined;
      if (action === "status") {
        const listed = Array.from(jobs.values()).filter((job) => job.kind === "subagent" && (!requestedId || job.sessionId === requestedId));
        const text = listed.map((job) => `${job.sessionId} ${job.state} ${job.command} (${Math.round((Date.now() - job.startedAt) / 1000)}s)`);
        return { content: [{ type: "text" as const, text: text.join("\n") || "No matching subagents." }], details: {} };
      }
      if (action === "stop") {
        if (!matching) throw new Error(`Running subagent not found: ${requestedId || "missing sessionId"}`);
        killJob(matching.pid);
        syncStatus(ctx);
        return { content: [{ type: "text" as const, text: `Stopped subagent ${matching.sessionId}` }], details: { sessionId: matching.sessionId } };
      }
      if (action === "steer") {
        if (!matching?.session || matching.state !== "running") throw new Error(`Running subagent not found: ${requestedId || "missing sessionId"}`);
        if (!message?.trim()) throw new Error("message is required for steer");
        await matching.session.steer(message.trim());
        return { content: [{ type: "text" as const, text: `Steered subagent ${matching.sessionId}` }], details: { sessionId: matching.sessionId } };
      }
      if (!prompt?.trim()) throw new Error("prompt is required for spawn");
      prompt = prompt.trim();
      if (requestedId && Array.from(jobs.values()).some((job) => job.sessionId === requestedId)) {
        throw new Error(`Subagent session ${requestedId} is already running`);
      }

      modelRuntime ??= ModelRuntime.create();
      const runtime = await modelRuntime;
      for (const providerId of ctx.modelRegistry.getRegisteredProviderIds()) {
        if (runtime.getRegisteredProviderIds().includes(providerId)) continue;
        const native = ctx.modelRegistry.getRegisteredNativeProvider(providerId);
        const config = ctx.modelRegistry.getRegisteredProviderConfig(providerId);
        if (native) runtime.registerNativeProvider(native);
        else if (config) runtime.registerProvider(providerId, config);
      }
      const modelSpec = model?.trim();
      const resolved = modelSpec ? resolveCliModel({ cliModel: modelSpec, cliThinking: thinking, modelRuntime: runtime }) : undefined;
      if (resolved?.error) throw new Error(resolved.error);
      if (resolved?.warning) console.warn(resolved.warning);
      const targetModel = resolved?.model ?? ctx.model;

      const childCwd = resolveSubagentCwd(ctx.cwd, cwd);
      const parentTools = pi.getActiveTools().filter((name) => name !== "bg" && name !== "subagent");
      const requestedTools = tools?.split(",").map((tool) => tool.trim()).filter(Boolean);
      const unknownTools = requestedTools?.filter((tool) => !parentTools.includes(tool)) ?? [];
      if (unknownTools.length) throw new Error(`Tools are not active in the parent session: ${unknownTools.join(", ")}`);
      const childTools = requestedTools ?? parentTools;
      const writer = childTools.some((tool) => !["read", "grep", "find", "ls"].includes(tool));

      mkdirSync(SUBAGENT_SESSION_DIR, { recursive: true, mode: 0o700 });
      const saved = requestedId && (await SessionManager.list(childCwd, SUBAGENT_SESSION_DIR)).find((item) => item.id === requestedId);
      if (requestedId && !saved) throw new Error(`Subagent session not found: ${requestedId}`);
      const sessionManager = saved
        ? SessionManager.open(saved.path, SUBAGENT_SESSION_DIR, childCwd)
        : SessionManager.create(childCwd, SUBAGENT_SESSION_DIR);
      const { session } = await createAgentSession({
        cwd: childCwd,
        model: targetModel,
        thinkingLevel: resolved?.thinkingLevel ?? thinking ?? ctx.thinkingLevel,
        tools: childTools,
        excludeTools: ["bg", "subagent"],
        modelRuntime: runtime,
        sessionManager,
      });
      const pid = nextVirtualPid--;
      const controller = new AbortController();
      let timedOut = false;
      let cancelled = false;
      controller.signal.addEventListener("abort", () => {
        cancelled = !timedOut;
        void session.abort();
      }, { once: true });
      const label = description?.trim() || (prompt.length > 30 ? `${prompt.slice(0, 30)}...` : prompt);
      const displayModel = modelSpec ?? (ctx.model && `${ctx.model.provider}/${ctx.model.id}`) ?? "Pi default";
      const job: BgJob = { pid, command: `Subagent: ${label}`, startedAt: Date.now(), sessionId: session.sessionId, controller, kind: "subagent", state: "queued", session, writer };
      jobs.set(pid, job);

      job.start = () => {
        if (controller.signal.aborted) return;
        activeSubagents++;
        if (writer) activeWriters++;
        job.state = "running";
        syncStatus(ctx);
        const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutSec * 1000);
        const finalize = () => {
          clearTimeout(timer);
          activeSubagents--;
          if (writer) activeWriters--;
          jobs.delete(pid);
          session.dispose();
          syncStatus(ctx);
          pumpSubagents();
        };
        void session.prompt(prompt).then(() => {
          const message = [...session.messages].reverse().find((item: any) => item.role === "assistant") as any;
          const rawText = message?.content?.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n").trim();
          const text = rawText ? truncateTail(rawText).content : "";
          const error = message?.errorMessage as string | undefined;
          const usage = message?.usage;
          const state = timedOut ? "timed-out" : cancelled ? "stopped" : error ? "failed" : "finished";
          const usageText = usage ? `\n\nSubagent Usage: in:${usage.input} out:${usage.output}${usage.cacheRead ? ` R${usage.cacheRead}` : ""}${usage.cacheWrite ? ` W${usage.cacheWrite}` : ""}${usage.cost?.total ? ` ($${usage.cost.total.toFixed(4)})` : ""}` : "";
          const recovery = (state === "failed" || state === "stopped" || state === "timed-out")
            ? `\n\nSession ${session.sessionId} is saved and can be resumed with subagent spawn(sessionId: "${session.sessionId}", prompt: "...").`
            : "";
          deliverCompletion(`${getSubagentHeading(error, timedOut, cancelled)}\nTask: Subagent: ${label}${text ? `\n\nResult:\n${text}` : ""}${error ? `\n\nReason: ${error}` : ""}${recovery}${usageText}`, ctx, completion);
        }, (error) => {
          const reason = error instanceof Error ? error.message : String(error);
          deliverCompletion(`${getSubagentHeading(reason, timedOut, cancelled)}\nTask: Subagent: ${label}\n\nReason: ${reason}\n\nSession ${session.sessionId} can be resumed after correcting the error.`, ctx, completion);
        }).finally(finalize);
      };
      subagentQueue.push(job);
      pumpSubagents();
      syncStatus(ctx);

      return {
        content: [{ type: "text", text: `${job.state === "running" ? "Started" : "Queued"}: Subagent: ${label}\nThe result will arrive automatically. Continue other work; do not wait, sleep, or poll. Use subagent status or /bg to inspect or stop it.\nSession: ${session.sessionId}\nModel: ${displayModel}` }],
        details: { pid, sessionId: session.sessionId, model: displayModel, state: job.state },
      };
    },
  });
}
