import { createAgentSession, DefaultResourceLoader, getAgentDir, ModelRuntime, resolveCliModel, SessionManager, truncateTail } from "@earendil-works/pi-coding-agent";
import type { AgentSession, ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { spawn, spawnSync } from "node:child_process";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LOG_DIR = join(tmpdir(), "pi-bg");
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
}

export function formatStatus(running: number, pending: number) {
  return [running && `${running} bg`, pending && `${pending} bg done`].filter(Boolean).join(" · ");
}

export function getDeliveryOptions(isIdle: boolean, completion: "queue" | "continue") {
  return {
    deliverAs: "steer" as const,
    triggerTurn: isIdle && completion === "continue",
  };
}

export function getSubagentHeading(error?: string, timedOut = false, cancelled = false) {
  return timedOut ? "Background subagent timed out" : cancelled ? "Background subagent was stopped" : error ? "Background subagent failed" : "Background subagent finished";
}

export default function (pi: ExtensionAPI) {
  const jobs = new Map<number, BgJob>();
  let pendingResults = 0;
  let nextVirtualPid = -1;
  let modelRuntime: Promise<ModelRuntime> | undefined;
  let activeSubagents = 0;
  const subagentQueue: Array<() => void> = [];

  const renderMessage = (content: string, theme: Theme, padding: number) => {
    const newline = content.indexOf("\n");
    const heading = newline < 0 ? content : content.slice(0, newline);
    const rest = newline < 0 ? "" : content.slice(newline);
    const styledHeading = heading.includes("finished")
      ? theme.fg("success", heading)
      : heading.includes("failed") || heading.includes("could not")
      ? theme.fg("error", heading)
      : theme.fg("warning", heading);
    return new Text(styledHeading + theme.fg("customMessageText", rest), padding, 0);
  };

  pi.registerEntryRenderer<{ content: string }>("pi-bg-result", (entry, _options, theme) =>
    renderMessage(entry.data.content, theme, 1)
  );
  pi.registerMessageRenderer("pi-bg-result", (message, { outputPad }, theme) =>
    renderMessage(message.content, theme, outputPad)
  );

  // Remove tool_call sleep blocker - triggerTurn: true handles turn wake-up cleanly

  function syncStatus(ctx: ExtensionContext) {
    try {
      const status = formatStatus(jobs.size, pendingResults);
      ctx.ui.setStatus("bg-jobs", status ? `${ctx.ui.theme.fg("accent", "● ")}${status}` : undefined);
    } catch {}
  }

  function deliverCompletion(message: string, ctx: ExtensionContext, completion: "queue" | "continue") {
    const isIdle = ctx.isIdle();
    pi.sendMessage({ customType: "pi-bg-result", content: message, display: true }, getDeliveryOptions(isIdle, completion));
    if (isIdle && completion === "queue") {
      pendingResults++;
      syncStatus(ctx);
    }
  }

  function killJob(pid: number): boolean {
    const job = jobs.get(pid);
    if (!job) return false;
    job.controller.abort();
    return true;
  }

  function runBgProcess(command: string, timeoutSec: number, ctx: ExtensionContext) {
    const shownCommand = command.length > 120 ? `${command.slice(0, 117)}...` : command;
    mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
    const logFile = join(LOG_DIR, `${randomUUID()}.log`);
    const out = openSync(logFile, "wx", 0o600);
    let proc;
    try {
      proc = spawn("bash", ["-c", command], { cwd: ctx.cwd, detached: true, stdio: ["ignore", out, out] });
    } finally {
      closeSync(out);
    }
    proc.unref();

    const pid = proc.pid;
    const controller = new AbortController();
    let timedOut = false;
    let cancelled = false;
    controller.signal.addEventListener("abort", () => {
      cancelled = !timedOut;
      if (!pid) return;
      if (process.platform === "win32") {
        spawnSync("taskkill", ["/T", "/PID", String(pid)], { stdio: "ignore" });
        setTimeout(() => { if (jobs.has(pid)) spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore" }); }, 2000).unref();
      } else {
        try { process.kill(-pid, "SIGINT"); } catch { try { process.kill(pid, "SIGINT"); } catch {} }
        setTimeout(() => {
          if (!jobs.has(pid)) return;
          try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch {} }
        }, 2000).unref();
      }
    }, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutSec * 1000);
    if (pid) jobs.set(pid, { pid, command: shownCommand, startedAt: Date.now(), controller, kind: "shell", state: "running" });
    syncStatus(ctx);

    let spawnError: string | undefined;
    proc.once("error", (error) => { spawnError = error.message; });
    proc.once("close", (code) => {
      clearTimeout(timer);
      if (pid) jobs.delete(pid);
      const content = readFileSync(logFile, "utf8").trim();
      const truncated = truncateTail(content);
      const keepLog = code !== 0 || Boolean(spawnError) || truncated.truncated;
      const heading = timedOut
        ? `Background task timed out after ${timeoutSec} seconds`
        : cancelled ? "Background task was stopped"
        : spawnError ? "Background task could not start"
        : code === 0 ? "Background task finished"
        : "Background task failed";
      const result = content ? `\n\nResult:\n${truncated.content}${truncated.truncated ? `\n\nThe result was shortened. Full result: ${logFile}` : ""}` : "";
      const reason = spawnError ? `\n\nReason: ${spawnError}` : code ? `\n\nExit code: ${code}` : "";
      pi.appendEntry("pi-bg-result", { content: `${heading}\nTask: ${shownCommand}${reason}${result}${keepLog ? `\n\nTroubleshooting log: ${logFile}` : ""}` });
      if (!keepLog) unlinkSync(logFile);
      syncStatus(ctx);
    });

    return {
      content: [{ type: "text" as const, text: `Started: ${shownCommand}\nThe result will arrive automatically. Continue other work; do not wait, sleep, or poll. Use /bg to view or stop the task.` }],
      details: { pid, logFile },
    };
  }

  pi.on("session_start", (_e, ctx) => {
    syncStatus(ctx);
    try {
      const now = Date.now();
      for (const file of readdirSync(LOG_DIR)) {
        const fullPath = join(LOG_DIR, file);
        try {
          const stat = statSync(fullPath);
          if (now - stat.mtimeMs > 86_400_000) {
            if (stat.isDirectory()) {
              rmSync(fullPath, { recursive: true, force: true });
            } else {
              unlinkSync(fullPath);
            }
          }
        } catch {}
      }
    } catch {}
  });

  pi.on("before_agent_start", (_e, ctx) => {
    if (pendingResults) {
      pendingResults = 0;
      syncStatus(ctx);
    }
  });

  pi.on("session_shutdown", () => {
    for (const pid of jobs.keys()) killJob(pid);
  });

  async function manageJobs(ctx: ExtensionContext) {
    if (jobs.size === 0) return ctx.ui.notify("No background jobs running", "info");
    const choice = await ctx.ui.select("Select job to stop:", [
      "Cancel",
      ...Array.from(jobs.values(), (job) =>
        `⚙ [${job.pid}] ${job.state === "queued" ? "queued " : ""}${job.command}${job.sessionId ? ` [session: ${job.sessionId.slice(0, 8)}]` : ""} (${Math.round((Date.now() - job.startedAt) / 1000)}s)`
      ),
    ]);
    const pid = Number(choice?.match(/\[(-?\d+)\]/)?.[1]);
    if (choice !== "Cancel" && Number.isInteger(pid) && killJob(pid)) {
      ctx.ui.notify(`Stopped background job ${pid}`, "info");
      syncStatus(ctx);
    }
  }

  pi.registerShortcut("ctrl+shift+b", {
    description: "View and manage background jobs",
    handler: manageJobs,
  });

  pi.registerCommand("bg", {
    description: "List and manage background jobs",
    getArgumentCompletions: (prefix) => {
      const items = Array.from(jobs.values(), (job) => ({
        value: `kill ${job.pid}`,
        label: `kill ${job.pid}`,
        description: job.command,
      })).filter((item) => item.value.startsWith(prefix));
      return items.length ? items : null;
    },
    handler: async (args, ctx) => {
      const trimmed = args?.trim() ?? "";
      const killMatch = trimmed.match(/^(?:kill\s+)?(-?\d+)$/);
      if (killMatch) {
        const pid = Number(killMatch[1]);
        if (killJob(pid)) {
          ctx.ui.notify(`Killed background job ${pid}`, "info");
          syncStatus(ctx);
        } else {
          ctx.ui.notify(`No background job found with PID ${pid}`, "error");
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
    description: "Run long-running shell commands in the background without blocking the agent session.",
    promptSnippet: "Run long-running shell commands in the background without blocking the agent session.",
    promptGuidelines: [
      "Use bg for long-running processes (e.g. dev servers, builds, test suites, heavy installs, long background tasks) or when the user asks to run commands while continuing discussion.",
      "Use standard bash for quick commands with immediate output (e.g. ls, git status, file reads).",
      "After starting bg, continue work immediately; never wait, sleep, or poll for completion.",
    ],
    parameters: Type.Object({
      command: Type.String({ description: "Shell command" }),
      timeoutSec: Type.Optional(Type.Number({ minimum: 1, maximum: 2_147_483, description: "Timeout in seconds (default: 600)" })),
    }),
    async execute(id, { command, timeoutSec = 600 }, _sig, _up, ctx) {
      return runBgProcess(command, timeoutSec, ctx);
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
      "For independent tasks, call subagent multiple times in one turn; Pi runs sibling tool calls in parallel.",
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
      systemPrompt: Type.Optional(Type.String({ description: "Extra system instructions" })),
      tools: Type.Optional(Type.String({ description: "Comma-separated tool allowlist" })),
      timeoutSec: Type.Optional(Type.Number({ minimum: 1, maximum: 2_147_483, description: "Timeout in seconds (default: 600)" })),
    }),
    async execute(id, { action = "spawn", prompt, description, sessionId, message, completion = "continue", model, thinking, systemPrompt, tools, timeoutSec = 600 }, _sig, _up, ctx) {
      const requestedId = sessionId?.trim();
      const matching = requestedId && Array.from(jobs.values()).find((job) => job.kind === "subagent" && job.sessionId === requestedId);
      if (action === "status") {
        const listed = Array.from(jobs.values()).filter((job) => job.kind === "subagent" && (!requestedId || job.sessionId === requestedId));
        return { content: [{ type: "text" as const, text: listed.length ? listed.map((job) => `${job.sessionId} ${job.state} ${job.command} (${Math.round((Date.now() - job.startedAt) / 1000)}s)`).join("\n") : "No matching subagents." }], details: { jobs: listed.map(({ controller, session, ...job }) => job) } };
      }
      if (action === "stop") {
        if (!matching) throw new Error(`Running subagent not found: ${requestedId || "missing sessionId"}`);
        matching.controller.abort();
        if (matching.state === "queued") {
          jobs.delete(matching.pid);
          syncStatus(ctx);
        }
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
      const modelSpec = model?.trim() || (ctx.model && `${ctx.model.provider}/${ctx.model.id}`);
      const resolved = modelSpec ? resolveCliModel({ cliModel: modelSpec, cliThinking: thinking, modelRuntime: runtime }) : undefined;
      if (resolved?.error) throw new Error(resolved.error);
      if (resolved?.warning) console.warn(resolved.warning);
      const targetModel = resolved?.model;

      mkdirSync(SUBAGENT_SESSION_DIR, { recursive: true, mode: 0o700 });
      const saved = requestedId && (await SessionManager.list(ctx.cwd, SUBAGENT_SESSION_DIR)).find((item) => item.id === requestedId);
      if (requestedId && !saved) throw new Error(`Subagent session not found: ${requestedId}`);
      const sessionManager = saved
        ? SessionManager.open(saved.path, SUBAGENT_SESSION_DIR, ctx.cwd)
        : SessionManager.create(ctx.cwd, SUBAGENT_SESSION_DIR);
      const loader = systemPrompt
        ? new DefaultResourceLoader({ cwd: ctx.cwd, agentDir: getAgentDir(), systemPromptOverride: (base) => `${base ?? ""}\n\n${systemPrompt}` })
        : undefined;
      await loader?.reload();

      const { session } = await createAgentSession({
        cwd: ctx.cwd,
        model: targetModel,
        thinkingLevel: resolved?.thinkingLevel ?? thinking,
        tools: tools?.split(",").map((tool) => tool.trim()).filter(Boolean),
        modelRuntime: runtime,
        resourceLoader: loader,
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
      const job: BgJob = { pid, command: `Subagent: ${label}`, startedAt: Date.now(), sessionId: session.sessionId, controller, kind: "subagent", state: "queued", session };
      jobs.set(pid, job);

      const start = () => {
        if (controller.signal.aborted) {
          jobs.delete(pid);
          session.dispose();
          subagentQueue.shift()?.();
          return syncStatus(ctx);
        }
        activeSubagents++;
        job.state = "running";
        syncStatus(ctx);
        const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutSec * 1000);
        void session.prompt(prompt).then(() => {
          const message = [...session.messages].reverse().find((item: any) => item.role === "assistant") as any;
          const rawText = message?.content?.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n").trim();
          const text = rawText && truncateTail(rawText).content;
          const error = message?.errorMessage;
          const usage = message?.usage;
          const usageText = usage ? `\n\nSubagent Usage: ↑${usage.input} ↓${usage.output}${usage.cacheRead ? ` R${usage.cacheRead}` : ""}${usage.cacheWrite ? ` W${usage.cacheWrite}` : ""}${usage.cost?.total ? ` ($${usage.cost.total.toFixed(4)})` : ""}` : "";
          deliverCompletion(`${getSubagentHeading(error, timedOut, cancelled)}\nTask: Subagent: ${label}${text ? `\n\nResult:\n${text}` : ""}${error ? `\n\nReason: ${error}` : ""}${usageText}`, ctx, completion);
        }).catch((error) => {
          deliverCompletion(`${getSubagentHeading(String(error), timedOut, cancelled)}\nTask: Subagent: ${label}\n\nReason: ${error}`, ctx, completion);
        }).finally(() => {
          clearTimeout(timer);
          activeSubagents--;
          jobs.delete(pid);
          session.dispose();
          syncStatus(ctx);
          subagentQueue.shift()?.();
        });
      };
      if (activeSubagents < 4) start(); else { subagentQueue.push(start); syncStatus(ctx); }

      const displayModel = modelSpec ?? "Pi default";
      return {
        content: [{ type: "text", text: `${job.state === "running" ? "Started" : "Queued"}: Subagent: ${label}\nThe result will arrive automatically. Continue other work; do not wait, sleep, or poll. Use subagent status or /bg to inspect or stop it.\nSession: ${session.sessionId}\nModel: ${displayModel}` }],
        details: { pid, sessionId: session.sessionId, model: displayModel, state: job.state },
      };
    },
  });
}
