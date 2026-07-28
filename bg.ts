import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const LOG_DIR = join(tmpdir(), "pi-bg");
const SUBAGENT_SESSION_DIR = join(LOG_DIR, "sessions");

interface BgJob {
  pid: number;
  command: string;
  startedAt: number;
  sessionId?: string;
  stopping?: boolean;
}

export function getSubagentSession(sessionId?: string) {
  const isCustom = Boolean(sessionId?.trim());
  const id = sessionId?.trim() || randomUUID();
  const args = isCustom
    ? ["--session-id", id, "--session-dir", SUBAGENT_SESSION_DIR]
    : ["--no-session", "--session-id", id];
  return { id, args };
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

export default function (pi: ExtensionAPI) {
  const jobs = new Map<number, BgJob>();
  let pendingResults = 0;

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

  function killJob(pid: number, graceful = true): boolean {
    const job = jobs.get(pid);
    if (!job) return false;
    try {
      if (process.platform === "win32") {
        const result = spawnSync("taskkill", [graceful ? "/T" : "/F", "/PID", String(pid)], { stdio: "ignore" });
        return !result.error && result.status === 0;
      }
      const signal = graceful ? "SIGINT" : "SIGKILL";
      try { process.kill(-pid, signal); } catch { process.kill(pid, signal); }
      if (graceful && !job.stopping) {
        job.stopping = true;
        setTimeout(() => { if (jobs.has(pid)) killJob(pid, false); }, 2000).unref();
      }
      return true;
    } catch {
      return false;
    }
  }

  function getPiInvocation(args: string[]): [string, string[]] {
    const script = process.argv[1];
    if (script && !script.startsWith("/$bunfs/root/") && existsSync(script)) {
      return [process.execPath, [script, ...args]];
    }
    return /^(node|bun)(\.exe)?$/.test(basename(process.execPath).toLowerCase())
      ? ["pi", args]
      : [process.execPath, args];
  }

  function runBgProcess(
    file: string,
    args: string[],
    displayCommand: string,
    timeoutSec: number,
    ctx: ExtensionContext,
    cleanupFiles: string[] = [],
    includeInContext = false,
    sessionId?: string,
    completion: "queue" | "continue" = "queue",
    isSubagent = false,
  ) {
    const shownCommand = displayCommand.length > 120 ? `${displayCommand.slice(0, 117)}...` : displayCommand;
    mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
    const logFile = join(LOG_DIR, `${randomUUID()}.log`);
    const out = openSync(logFile, "wx", 0o600);
    let proc;
    try {
      proc = spawn(file, args, { cwd: ctx.cwd, detached: true, stdio: ["ignore", out, out] });
    } finally {
      closeSync(out);
    }
    proc.unref();

    let timedOut = false;
    let spawnError: string | undefined;
    proc.once("error", (error) => { spawnError = error.message; });
    const timer = setTimeout(() => {
      if (proc.pid && jobs.has(proc.pid)) {
        timedOut = true;
        killJob(proc.pid);
      }
    }, timeoutSec * 1000);

    if (proc.pid) {
      jobs.set(proc.pid, { pid: proc.pid, command: shownCommand, startedAt: Date.now(), sessionId });
      syncStatus(ctx);
    }

    proc.once("close", (code, signal) => {
      clearTimeout(timer);
      if (proc.pid) jobs.delete(proc.pid);
      syncStatus(ctx);

      const heading = timedOut
        ? `Background task timed out after ${timeoutSec} seconds`
        : spawnError
        ? "Background task could not start"
        : code === 0
        ? "Background task finished"
        : signal
        ? "Background task was stopped"
        : "Background task failed";
      let result = "";
      let keepLog = code !== 0 || Boolean(spawnError);
      let parsedUsage: any = undefined;

      try {
        const content = readFileSync(logFile, "utf-8").trim();

        if (isSubagent && content) {
          const lines = content.split("\n");
          const texts: string[] = [];
          let input = 0, output = 0, cacheRead = 0, cacheWrite = 0, costTotal = 0;
          let foundJson = false;

          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const event = JSON.parse(line);
              if (event && typeof event === "object") {
                foundJson = true;
                if (event.type === "message_end" && event.message?.role === "assistant") {
                  const msg = event.message;
                  if (Array.isArray(msg.content)) {
                    for (const part of msg.content) {
                      if (part?.type === "text" && part.text) texts.push(part.text);
                    }
                  }
                  if (msg.errorMessage) {
                    texts.push(`Error: ${msg.errorMessage}`);
                  }
                  if (msg.usage) {
                    input += msg.usage.input || 0;
                    output += msg.usage.output || 0;
                    cacheRead += msg.usage.cacheRead || 0;
                    cacheWrite += msg.usage.cacheWrite || 0;
                    costTotal += (typeof msg.usage.cost === "object" ? msg.usage.cost?.total : msg.usage.cost) || 0;
                  }
                }
              }
            } catch {}
          }

          if (foundJson) {
            const outText = texts.join("\n").trim();
            result = outText ? `\n\nResult:\n${outText}` : "";
            const totalTokens = input + output + cacheRead + cacheWrite;
            if (totalTokens > 0 || costTotal > 0) {
              parsedUsage = {
                input,
                output,
                cacheRead,
                cacheWrite,
                totalTokens,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: costTotal },
              };
            }
          }
        }

        if (!parsedUsage && content.length > 2000) {
          const head = content.slice(0, 1000).replace(/\s+\S*$/, "");
          const tail = content.slice(-1000).replace(/^\S*\s+/, "");
          result = `\n\nResult:\n${head}\n\n[Middle omitted]\n\n${tail}\n\nThe result was shortened. Full result: ${logFile}`;
          keepLog = true;
        } else if (!parsedUsage && content) {
          result = `\n\nResult:\n${content}`;
        }
      } catch {}

      if (parsedUsage) {
        const u = parsedUsage;
        const tokens = `↑${u.input} ↓${u.output}${u.cacheRead ? ` R${u.cacheRead}` : ""}${u.cacheWrite ? ` W${u.cacheWrite}` : ""}`;
        const costStr = u.cost.total > 0 ? ` ($${u.cost.total.toFixed(4)})` : "";
        result += `\n\nSubagent Usage: ${tokens}${costStr}`;

        try {
          (ctx.sessionManager as any).appendMessage({
            role: "toolResult",
            toolCallId: randomUUID(),
            toolName: "subagent",
            content: [{ type: "text", text: `[Subagent usage recorded]` }],
            usage: parsedUsage,
            isError: code !== 0,
            timestamp: Date.now(),
          });
        } catch (e) {
          console.error("Failed to append subagent toolResult usage", e);
        }
      }

      const reason = spawnError ? `\n\nReason: ${spawnError}` : code && code !== 0 ? `\n\nExit code: ${code}` : "";
      const troubleshooting = code === 0 ? "" : `\n\nTroubleshooting log: ${logFile}`;
      const msg = `${heading}\nTask: ${shownCommand}${reason}${result}${troubleshooting}`;
      try {
        if (includeInContext) {
          let isIdle = false;
          try { isIdle = ctx.isIdle(); } catch {}
          pi.sendMessage(
            { customType: "pi-bg-result", content: msg, display: true },
            getDeliveryOptions(isIdle, completion),
          );
          if (isIdle && completion === "queue") {
            pendingResults++;
            syncStatus(ctx);
          }
        } else {
          pi.appendEntry("pi-bg-result", { content: msg });
        }
        if (!keepLog) unlinkSync(logFile);
      } catch (error) {
        console.error(`pi-bg could not deliver a result. Full result: ${logFile}`, error);
      }
      for (const file of cleanupFiles) try { unlinkSync(file); } catch {}
    });

    return {
      content: [{
        type: "text",
        text: `Started: ${shownCommand}\nThe result will arrive automatically. Continue other work; do not wait, sleep, or poll. Use /bg to view or stop the task.`,
      }],
      details: { pid: proc.pid, logFile },
    };
  }

  pi.on("session_start", (_e, ctx) => {
    syncStatus(ctx);
    try {
      const now = Date.now();
      for (const file of readdirSync(LOG_DIR)) {
        const fullPath = join(LOG_DIR, file);
        try {
          if (now - statSync(fullPath).mtimeMs > 86_400_000) unlinkSync(fullPath);
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
    for (const pid of jobs.keys()) killJob(pid, false);
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
      const killMatch = trimmed.match(/^(?:kill\s+)?(\d+)$/);
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

      if (jobs.size === 0) {
        ctx.ui.notify("No background jobs running", "info");
        return;
      }

      const items = Array.from(jobs.values()).map(
        (j) => `⚙ [${j.pid}] ${j.command}${j.sessionId ? ` [session: ${j.sessionId.slice(0, 8)}]` : ""} (${Math.round((Date.now() - j.startedAt) / 1000)}s)`
      );

      if (!ctx.hasUI) return;

      const choice = await ctx.ui.select("Select job to stop:", ["Cancel", ...items]);
      if (choice && choice !== "Cancel") {
        const match = choice.match(/\[(\d+)\]/);
        if (match) {
          const pid = parseInt(match[1], 10);
          if (killJob(pid)) {
            ctx.ui.notify(`Stopped background job ${pid}`, "info");
            syncStatus(ctx);
          }
        }
      }
    },
  });

  pi.registerTool({
    name: "bg",
    label: "Background",
    description: "Run long-running shell commands in the background without blocking the agent session.",
    promptGuidelines: [
      "Use bg for long-running processes (e.g. dev servers, builds, test suites, heavy installs, long background tasks) or when the user asks to run commands while continuing discussion.",
      "Use standard bash for quick commands with immediate output (e.g. ls, git status, file reads).",
      "After starting bg, continue work immediately; never wait, sleep, or poll for completion.",
    ],
    parameters: Type.Object({
      command: Type.String({ description: "Shell command" }),
      timeoutSec: Type.Optional(Type.Number({ minimum: 1, maximum: 2_147_483, description: "Timeout in seconds (default: 600)" })),
    }),
    renderCall({ command }, theme) {
      const shown = command.length > 100 ? `${command.slice(0, 97)}...` : command;
      return new Text(`${theme.fg("toolTitle", theme.bold("background "))}${theme.fg("toolOutput", shown)}`, 0, 0);
    },
    renderResult(result, _options, theme) {
      const pid = result.details?.pid ? theme.fg("dim", ` [${result.details.pid}]`) : "";
      return new Text(`${theme.fg("success", "Started")}${pid}`, 0, 0);
    },
    async execute(id, { command, timeoutSec = 600 }, _sig, _up, ctx) {
      return runBgProcess("bash", ["-c", command], command, timeoutSec, ctx);
    },
  });

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: "Delegate complex, isolated, or deep exploration tasks to a background subagent.",
    promptGuidelines: [
      "Use subagent for multi-step sub-tasks, background research, code audits, refactoring, or sub-problems to keep main context uncluttered.",
      "Provide complete and self-contained instructions in prompt so the subagent has full context to complete the task.",
      "Reuse sessionId from an earlier subagent result to continue conversation state with that subagent.",
      "For high-level or non-technical requests ('check performance', 'audit security', 'investigate codebase'), delegate isolated sub-tasks to subagent.",
    ],
    parameters: Type.Object({
      prompt: Type.String({ description: "Task" }),
      sessionId: Type.Optional(Type.String({ description: "Session ID from an earlier subagent result to continue it" })),
      completion: Type.Optional(StringEnum(["queue", "continue"] as const, { description: "continue wakes the parent turn automatically when ready (default); queue waits for user's next prompt" })),
      model: Type.Optional(Type.String({ description: "Preferred model" })),
      thinking: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const, { description: "Thinking level" })),
      systemPrompt: Type.Optional(Type.String({ description: "Extra system instructions" })),
      tools: Type.Optional(Type.String({ description: "Comma-separated tool allowlist" })),
      timeoutSec: Type.Optional(Type.Number({ minimum: 1, maximum: 2_147_483, description: "Timeout in seconds (default: 600)" })),
    }),
    renderCall({ prompt }, theme) {
      const shown = prompt.length > 100 ? `${prompt.slice(0, 97)}...` : prompt;
      return new Text(`${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("toolOutput", shown)}`, 0, 0);
    },
    renderResult(result, _options, theme) {
      const model = result.details?.model ? theme.fg("dim", ` (${result.details.model})`) : "";
      return new Text(`${theme.fg("success", "Started")}${model}`, 0, 0);
    },
    async execute(id, { prompt, sessionId, completion = "continue", model, thinking, systemPrompt, tools, timeoutSec = 600 }, _sig, _up, ctx) {
      const available = ctx.modelRegistry.getAvailable();
      const requested = model?.trim().toLowerCase();
      const exact = requested && available.find((m) =>
        m.id.toLowerCase() === requested || `${m.provider}/${m.id}`.toLowerCase() === requested
      );
      const fuzzy = requested ? available.filter((m) =>
        m.id.toLowerCase().includes(requested) || m.name?.toLowerCase().includes(requested)
      ) : [];
      const requestedModel = exact || (fuzzy.length === 1 ? fuzzy[0] : undefined);
      const selected = requestedModel ??
        (ctx.model && available.find((m) => m.provider === ctx.model.provider && m.id === ctx.model.id));

      const session = getSubagentSession(sessionId);
      if (Array.from(jobs.values()).some((job) => job.sessionId === session.id)) {
        throw new Error(`Subagent session ${session.id} is already running`);
      }
      const args = ["--mode", "json", "-p", ...session.args, ctx.isProjectTrusted() ? "--approve" : "--no-approve"];
      const cleanupFiles: string[] = [];
      if (selected) args.push("--model", `${selected.provider}/${selected.id}`);
      if (thinking) args.push("--thinking", thinking);
      if (systemPrompt) {
        mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
        const promptFile = join(LOG_DIR, `prompt-${randomUUID()}.md`);
        writeFileSync(promptFile, systemPrompt, { mode: 0o600, flag: "wx" });
        cleanupFiles.push(promptFile);
        args.push("--append-system-prompt", promptFile);
      }
      if (tools) args.push("--tools", tools);
      args.push(prompt);

      const label = prompt.length > 30 ? `${prompt.slice(0, 30)}...` : prompt;
      const displayCmd = `Subagent: ${label}`;
      const [file, invocationArgs] = getPiInvocation(args);
      try {
        const job = runBgProcess(file, invocationArgs, displayCmd, timeoutSec, ctx, cleanupFiles, true, session.id, completion, true);
        const selectedModel = selected ? `${selected.provider}/${selected.id}` : "Pi automatic selection";
        job.content[0].text += `\nSession: ${session.id}\nModel: ${selectedModel}`;
        return { ...job, details: { ...job.details, sessionId: session.id, model: selectedModel } };
      } catch (error) {
        for (const file of cleanupFiles) try { unlinkSync(file); } catch {}
        throw error;
      }
    },
  });
}
