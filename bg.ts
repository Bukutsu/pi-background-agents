import { createAgentSession, DefaultResourceLoader, getAgentDir, getMarkdownTheme, keyHint, ModelRuntime, resolveCliModel, SessionManager, truncateTail } from "@earendil-works/pi-coding-agent";
import type { AgentSession, ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { spawn, spawnSync } from "node:child_process";
import { Type } from "typebox";
import { Box, Markdown, Text } from "@earendil-works/pi-tui";
import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

const LOG_DIR = join(tmpdir(), "pi-bg");
const SUBAGENT_SESSION_DIR = join(LOG_DIR, "sessions");
const HISTORY_FILE = join(LOG_DIR, "jobs.json");

interface BgJob {
  pid: number;
  command: string;
  startedAt: number;
  sessionId?: string;
  controller: AbortController;
  kind: "shell" | "subagent";
  state: "queued" | "running";
  session?: AgentSession;
  logFile?: string;
  model?: string;
  cwd?: string;
  writer?: boolean;
  start?: () => void;
}

interface FinishedJob {
  pid: number;
  command: string;
  startedAt: number;
  finishedAt: number;
  sessionId?: string;
  kind: BgJob["kind"];
  state: "finished" | "failed" | "stopped" | "timed-out";
  model?: string;
  usage?: string;
  output?: string;
  logFile?: string;
  cwd?: string;
}

function formatStatus(running: number, pending: number) {
  return [running && `${running} bg`, pending && `${pending} bg done`].filter(Boolean).join(" · ");
}

function getDeliveryOptions(isIdle: boolean, completion: "queue" | "continue") {
  return {
    deliverAs: "steer" as const,
    triggerTurn: isIdle && completion === "continue",
  };
}

function getSubagentHeading(error?: string, timedOut = false, cancelled = false) {
  return timedOut ? "Background subagent timed out" : cancelled ? "Background subagent was stopped" : error ? "Background subagent failed" : "Background subagent finished";
}

export default function (pi: ExtensionAPI) {
  const jobs = new Map<number, BgJob>();
  let pendingResults = 0;
  let nextVirtualPid = -1;
  let modelRuntime: Promise<ModelRuntime> | undefined;
  let activeSubagents = 0;
  let activeWriters = 0;
  const subagentQueue: BgJob[] = [];
  let history: FinishedJob[] = [];
  try {
    history = JSON.parse(readFileSync(HISTORY_FILE, "utf8")).slice(0, 20);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn(`[pi-bg] Could not read job history: ${error}`);
  }

  const renderMessage = (content: string, theme: Theme, padding: number, expanded: boolean) => {
    const lines = content.split("\n");
    const heading = lines.shift() ?? "Background task";
    const taskIndex = lines.findIndex((line) => line.startsWith("Task: "));
    const task = taskIndex >= 0 ? lines.splice(taskIndex, 1)[0].replace(/^Task: (?:Subagent: )?/, "") : "Background task";
    const usageIndex = lines.findIndex((line) => line.startsWith("Subagent Usage: "));
    const usage = usageIndex >= 0 ? lines.splice(usageIndex, 1)[0].replace("Subagent Usage: ", "") : "";
    const success = heading.includes("finished");
    const failed = heading.includes("failed") || heading.includes("could not");
    const color = success ? "success" : failed ? "error" : "warning";
    const icon = success ? "✓" : failed ? "✗" : "■";
    const body = lines.join("\n").trim().replace(/^Result:\n/, "");
    const shown = expanded ? body : body.split("\n").slice(0, 12).join("\n");

    const box = new Box(padding, 1, (text) => theme.bg("customMessageBg", text));
    box.addChild(new Text(`${theme.fg(color, icon)} ${theme.bold(task)}`, 0, 0));
    box.addChild(new Text(theme.fg("dim", `${heading.replace(/^Background (?:subagent |task )?/, "")}${usage ? ` · ${usage}` : ""}`), 0, 0));
    if (shown) box.addChild(new Markdown(shown, 0, 1, getMarkdownTheme()));
    if (!expanded && shown !== body) box.addChild(new Text(theme.fg("dim", keyHint("app.tools.expand", "to expand")), 0, 0));
    return box;
  };

  pi.registerEntryRenderer<{ content: string }>("pi-bg-result", (entry, { expanded }, theme) =>
    renderMessage(entry.data?.content ?? "Background task", theme, 1, expanded)
  );
  pi.registerMessageRenderer("pi-bg-result", (message, { expanded, outputPad }, theme) =>
    renderMessage(typeof message.content === "string" ? message.content : "", theme, outputPad, expanded)
  );

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

  function remember(job: BgJob, state: FinishedJob["state"], details: Partial<FinishedJob> = {}) {
    history.unshift({ pid: job.pid, command: job.command, startedAt: job.startedAt, finishedAt: Date.now(), sessionId: job.sessionId, kind: job.kind, model: job.model, cwd: job.cwd, state, ...details });
    history.length = Math.min(history.length, 20);
    try {
      mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
      const temporary = `${HISTORY_FILE}.${process.pid}.tmp`;
      writeFileSync(temporary, JSON.stringify(history, null, 2), { mode: 0o600 });
      renameSync(temporary, HISTORY_FILE);
    } catch (error) {
      console.warn(`[pi-bg] Could not persist job history: ${error}`);
    }
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

  function describeFinished(job: FinishedJob) {
    return `${job.pid} ${job.state} ${job.command} (${Math.round((job.finishedAt - job.startedAt) / 1000)}s)${job.usage ? ` · ${job.usage}` : ""}`;
  }

  function tailFile(path: string, maxBytes = 50_000) {
    const size = statSync(path).size;
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    const fd = openSync(path, "r");
    try { readSync(fd, buffer, 0, length, size - length); } finally { closeSync(fd); }
    return `${size > length ? "… output truncated …\n" : ""}${buffer.toString("utf8")}`.trim();
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
    if (pid) jobs.set(pid, { pid, command: shownCommand, startedAt: Date.now(), controller, kind: "shell", state: "running", logFile });
    syncStatus(ctx);

    let spawnError: string | undefined;
    proc.once("error", (error) => { spawnError = error.message; });
    proc.once("close", (code) => {
      clearTimeout(timer);
      const job = pid === undefined ? undefined : jobs.get(pid);
      if (pid) jobs.delete(pid);
      const content = readFileSync(logFile, "utf8").trim();
      const truncated = truncateTail(content);
      const keepLog = code !== 0 || Boolean(spawnError) || truncated.truncated;
      const state: FinishedJob["state"] = timedOut ? "timed-out" : cancelled ? "stopped" : spawnError || code !== 0 ? "failed" : "finished";
      const heading = timedOut
        ? `Background task timed out after ${timeoutSec} seconds`
        : cancelled ? "Background task was stopped"
        : spawnError ? "Background task could not start"
        : code === 0 ? "Background task finished"
        : "Background task failed";
      const result = content ? `\n\nResult:\n${truncated.content}${truncated.truncated ? `\n\nThe result was shortened. Full result: ${logFile}` : ""}` : "";
      const reason = spawnError ? `\n\nReason: ${spawnError}` : code ? `\n\nExit code: ${code}` : "";
      pi.appendEntry("pi-bg-result", { content: `${heading}\nTask: ${shownCommand}${reason}${result}${keepLog ? `\n\nTroubleshooting log: ${logFile}` : ""}` });
      if (job) remember(job, state, { output: truncated.content, logFile: keepLog ? logFile : undefined });
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
      const items = [
        { value: "history", label: "history", description: "Show recent completed jobs" },
        ...Array.from(jobs.values(), (job) => ({ value: `kill ${job.pid}`, label: `kill ${job.pid}`, description: job.command })),
      ].filter((item) => item.value.startsWith(prefix));
      return items.length ? items : null;
    },
    handler: async (args, ctx) => {
      const trimmed = args?.trim() ?? "";
      if (trimmed === "history") {
        ctx.ui.notify(history.length ? history.map(describeFinished).join("\n") : "No completed background jobs", "info");
        return;
      }
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
    description: "Run, inspect, or stop long-running shell commands without blocking the agent session.",
    promptSnippet: "Run, inspect, or stop long-running shell commands without blocking the agent session.",
    promptGuidelines: [
      "Use bg for long-running processes (e.g. dev servers, builds, test suites, heavy installs, long background tasks) or when the user asks to run commands while continuing discussion.",
      "Use standard bash for quick commands with immediate output (e.g. ls, git status, file reads).",
      "After starting bg, continue work immediately; never wait, sleep, or poll for completion.",
    ],
    parameters: Type.Object({
      action: Type.Optional(StringEnum(["spawn", "status", "output", "stop"] as const, { description: "Action (default: spawn)" })),
      command: Type.Optional(Type.String({ description: "Shell command for spawn" })),
      pid: Type.Optional(Type.Number({ description: "Job PID for output or stop" })),
      timeoutSec: Type.Optional(Type.Number({ minimum: 1, maximum: 2_147_483, description: "Timeout in seconds (default: 600)" })),
    }),
    async execute(id, { action = "spawn", command, pid, timeoutSec = 600 }, _sig, _up, ctx) {
      const shellJobs = () => Array.from(jobs.values()).filter((job) => job.kind === "shell");
      if (action === "status") {
        const listed = shellJobs();
        const recent = history.filter((job) => job.kind === "shell");
        const text = [...listed.map((job) => `${job.pid} ${job.state} ${job.command} (${Math.round((Date.now() - job.startedAt) / 1000)}s)`), ...recent.map(describeFinished)];
        return { content: [{ type: "text" as const, text: text.join("\n") || "No shell jobs." }], details: { jobs: listed.map(({ controller, ...job }) => job), history: recent } };
      }
      const job = pid === undefined ? undefined : jobs.get(pid);
      if (action === "stop") {
        if (!job || job.kind !== "shell") throw new Error(`Shell job not found: ${pid ?? "missing pid"}`);
        job.controller.abort();
        return { content: [{ type: "text" as const, text: `Stopped shell job ${pid}` }], details: { pid } };
      }
      if (action === "output") {
        const done = history.find((item) => item.pid === pid && item.kind === "shell");
        if ((!job?.logFile || job.kind !== "shell") && !done) throw new Error(`Shell job not found: ${pid ?? "missing pid"}`);
        const text = job?.logFile ? tailFile(job.logFile) : done?.output || "No output.";
        return { content: [{ type: "text" as const, text }], details: { pid, logFile: job?.logFile ?? done?.logFile, state: done?.state } };
      }
      if (!command?.trim()) throw new Error("command is required for spawn");
      return runBgProcess(command.trim(), timeoutSec, ctx);
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
      tools: Type.Optional(Type.String({ description: "Comma-separated tool allowlist; can only narrow the parent's tools" })),
      cwd: Type.Optional(Type.String({ description: "Working directory inside the parent project" })),
      timeoutSec: Type.Optional(Type.Number({ minimum: 1, maximum: 2_147_483, description: "Timeout in seconds (default: 600)" })),
    }),
    async execute(_id, { action = "spawn", prompt, description, sessionId, message, completion = "continue", model, thinking, systemPrompt, tools, cwd, timeoutSec = 600 }, _sig, _up, ctx) {
      const requestedId = sessionId?.trim();
      const matching = requestedId ? Array.from(jobs.values()).find((job) => job.kind === "subagent" && job.sessionId === requestedId) : undefined;
      if (action === "status") {
        const listed = Array.from(jobs.values()).filter((job) => job.kind === "subagent" && (!requestedId || job.sessionId === requestedId));
        const recent = history.filter((job) => job.kind === "subagent" && (!requestedId || job.sessionId === requestedId));
        const text = [...listed.map((job) => `${job.sessionId} ${job.state} ${job.command} (${Math.round((Date.now() - job.startedAt) / 1000)}s)`), ...recent.map(describeFinished)];
        return { content: [{ type: "text" as const, text: text.join("\n") || "No matching subagents." }], details: { jobs: listed.map(({ controller, session, ...job }) => job), history: recent } };
      }
      if (action === "stop") {
        if (!matching) throw new Error(`Running subagent not found: ${requestedId || "missing sessionId"}`);
        matching.controller.abort();
        if (matching.state === "queued") {
          const index = subagentQueue.indexOf(matching);
          if (index >= 0) subagentQueue.splice(index, 1);
          jobs.delete(matching.pid);
          matching.session?.dispose();
          remember(matching, "stopped");
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

      const rememberedCwd = requestedId ? history.find((item) => item.sessionId === requestedId)?.cwd : undefined;
      const childCwd = resolveSubagentCwd(ctx.cwd, cwd ?? rememberedCwd);
      const parentTools = pi.getActiveTools().filter((name) => name !== "bg" && name !== "subagent");
      const requestedTools = tools?.split(",").map((tool) => tool.trim()).filter(Boolean);
      const unknownTools = requestedTools?.filter((tool) => !parentTools.includes(tool)) ?? [];
      if (unknownTools.length) throw new Error(`Tools are not active in the parent session: ${unknownTools.join(", ")}`);
      const childTools = requestedTools ?? parentTools;
      const writer = childTools.includes("write") || childTools.includes("edit");

      mkdirSync(SUBAGENT_SESSION_DIR, { recursive: true, mode: 0o700 });
      const saved = requestedId && (await SessionManager.list(childCwd, SUBAGENT_SESSION_DIR)).find((item) => item.id === requestedId);
      if (requestedId && !saved) throw new Error(`Subagent session not found: ${requestedId}`);
      const sessionManager = saved
        ? SessionManager.open(saved.path, SUBAGENT_SESSION_DIR, childCwd)
        : SessionManager.create(childCwd, SUBAGENT_SESSION_DIR);
      const loader = systemPrompt
        ? new DefaultResourceLoader({ cwd: childCwd, agentDir: getAgentDir(), systemPromptOverride: (base) => `${base ?? ""}\n\n${systemPrompt}` })
        : undefined;
      await loader?.reload();

      const { session } = await createAgentSession({
        cwd: childCwd,
        model: targetModel,
        thinkingLevel: resolved?.thinkingLevel ?? thinking ?? ctx.thinkingLevel,
        tools: childTools,
        excludeTools: ["bg", "subagent"],
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
      const displayModel = modelSpec ?? (ctx.model && `${ctx.model.provider}/${ctx.model.id}`) ?? "Pi default";
      const job: BgJob = { pid, command: `Subagent: ${label}`, startedAt: Date.now(), sessionId: session.sessionId, controller, kind: "subagent", state: "queued", session, model: displayModel, cwd: childCwd, writer };
      jobs.set(pid, job);

      const pump = () => {
        while (activeSubagents < 4) {
          const index = subagentQueue.findIndex((queued) => !queued.writer || activeWriters === 0);
          if (index < 0) return;
          subagentQueue.splice(index, 1)[0].start?.();
        }
      };
      job.start = () => {
        if (controller.signal.aborted) return;
        activeSubagents++;
        if (writer) activeWriters++;
        job.state = "running";
        syncStatus(ctx);
        const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutSec * 1000);
        let finalized = false;
        const finalize = (state: FinishedJob["state"], output = "", usage = "") => {
          if (finalized) return;
          finalized = true;
          clearTimeout(timer);
          activeSubagents--;
          if (writer) activeWriters--;
          jobs.delete(pid);
          remember(job, state, { output, usage });
          session.dispose();
          syncStatus(ctx);
          pump();
        };
        void session.prompt(prompt).then(() => {
          const message = [...session.messages].reverse().find((item: any) => item.role === "assistant") as any;
          const rawText = message?.content?.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n").trim();
          const text = rawText ? truncateTail(rawText).content : "";
          const error = message?.errorMessage as string | undefined;
          const usage = message?.usage;
          const state: FinishedJob["state"] = timedOut ? "timed-out" : cancelled ? "stopped" : error ? "failed" : "finished";
          const usageText = usage ? `\n\nSubagent Usage: ↑${usage.input} ↓${usage.output}${usage.cacheRead ? ` R${usage.cacheRead}` : ""}${usage.cacheWrite ? ` W${usage.cacheWrite}` : ""}${usage.cost?.total ? ` ($${usage.cost.total.toFixed(4)})` : ""}` : "";
          const recovery = state === "failed" ? `\n\nSession ${session.sessionId} can be resumed after correcting the error.` : "";
          deliverCompletion(`${getSubagentHeading(error, timedOut, cancelled)}\nTask: Subagent: ${label}${text ? `\n\nResult:\n${text}` : ""}${error ? `\n\nReason: ${error}` : ""}${recovery}${usageText}`, ctx, completion);
          finalize(state, text, usage ? `↑${usage.input} ↓${usage.output}${usage.cost?.total ? ` $${usage.cost.total.toFixed(4)}` : ""}` : "");
        }).catch((error) => {
          const state: FinishedJob["state"] = timedOut ? "timed-out" : cancelled ? "stopped" : "failed";
          const reason = error instanceof Error ? error.message : String(error);
          deliverCompletion(`${getSubagentHeading(reason, timedOut, cancelled)}\nTask: Subagent: ${label}\n\nReason: ${reason}\n\nSession ${session.sessionId} can be resumed after correcting the error.`, ctx, completion);
          finalize(state, reason);
        });
      };
      subagentQueue.push(job);
      pump();
      syncStatus(ctx);

      return {
        content: [{ type: "text", text: `${job.state === "running" ? "Started" : "Queued"}: Subagent: ${label}\nThe result will arrive automatically. Continue other work; do not wait, sleep, or poll. Use subagent status or /bg to inspect or stop it.\nSession: ${session.sessionId}\nModel: ${displayModel}` }],
        details: { pid, sessionId: session.sessionId, model: displayModel, state: job.state },
      };
    },
  });
}
