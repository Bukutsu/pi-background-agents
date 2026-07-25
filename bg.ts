import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn } from "node:child_process";
import { closeSync, openSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface BgJob {
  pid: number;
  command: string;
  startedAt: number;
}

export default function (pi: ExtensionAPI) {
  const jobs = new Map<number, BgJob>();

  function syncStatus(ctx: any) {
    try {
      ctx.ui.setStatus("bg-jobs", jobs.size > 0 ? `${ctx.ui.theme.fg("accent", "● ")}${jobs.size} bg` : undefined);
    } catch {}
  }

  function killJob(pid: number): boolean {
    if (!jobs.has(pid)) return false;
    try {
      if (process.platform === "win32") {
        try { process.kill(pid, "SIGKILL"); } catch {
          spawn("taskkill", ["/F", "/PID", String(pid), "/T"], { stdio: "ignore" }).unref();
        }
      } else {
        try { process.kill(-pid, "SIGKILL"); } catch { process.kill(pid, "SIGKILL"); }
      }
    } catch {}
    jobs.delete(pid);
    return true;
  }

  function runBgProcess(
    file: string,
    args: string[],
    displayCommand: string,
    timeoutSec: number,
    ctx: any
  ) {
    const logFile = join(tmpdir(), `pi-bg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.log`);
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
      jobs.set(proc.pid, { pid: proc.pid, command: displayCommand, startedAt: Date.now() });
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
      try {
        const content = readFileSync(logFile, "utf-8").trim();
        if (content.length > 2000) {
          const preview = content.slice(0, 2000).replace(/\s+\S*$/, "");
          result = `\n\nResult:\n${preview}\n\nThe result was shortened. Full result: ${logFile}`;
        } else if (content) {
          result = `\n\nResult:\n${content}`;
        }
      } catch {}

      const reason = spawnError ? `\n\nReason: ${spawnError}` : code && code !== 0 ? `\n\nExit code: ${code}` : "";
      const troubleshooting = code === 0 ? "" : `\n\nTroubleshooting log: ${logFile}`;
      const msg = `${heading}\nTask: ${displayCommand}${reason}${result}${troubleshooting}`;
      let isIdle = false;
      try { isIdle = ctx?.isIdle?.() ?? true; } catch {}
      try {
        pi.sendUserMessage(msg, { deliverAs: isIdle ? undefined : "followUp" });
      } catch {}
    });

    return {
      content: [{
        type: "text",
        text: `Started: ${displayCommand}\nYou can keep working. The result will appear here when it is ready. Use /bg to view or stop the task.`,
      }],
      details: { pid: proc.pid, logFile },
    };
  }

  pi.on("session_start", (_e, ctx) => {
    syncStatus(ctx);
    try {
      const now = Date.now();
      const dayMs = 24 * 60 * 60 * 1000;
      const dir = tmpdir();
      for (const file of readdirSync(dir)) {
        if (file.startsWith("pi-bg-") && file.endsWith(".log")) {
          const fullPath = join(dir, file);
          try {
            const stat = statSync(fullPath);
            if (now - stat.mtimeMs > dayMs) unlinkSync(fullPath);
          } catch {}
        }
      }
    } catch {}
  });

  pi.on("session_shutdown", () => {
    for (const pid of jobs.keys()) killJob(pid);
  });

  pi.registerCommand("bg", {
    description: "List and manage background jobs",
    handler: async (args, ctx) => {
      const trimmed = args?.trim() ?? "";
      if (trimmed.startsWith("kill ") || /^\d+$/.test(trimmed)) {
        const pid = parseInt(trimmed.replace(/^kill\s+/, ""), 10);
        if (killJob(pid)) {
          ctx.ui.notify(`Killed background job ${pid}`, "info");
          syncStatus(ctx);
        } else {
          ctx.ui.notify(`No background job found with PID ${pid}`, "error");
        }
        return;
      }

      if (jobs.size === 0) {
        ctx.ui.notify("No background jobs running", "info");
        return;
      }

      const items = Array.from(jobs.values()).map(
        (j) => `⚙ [${j.pid}] ${j.command} (${Math.round((Date.now() - j.startedAt) / 1000)}s)`
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
    description: "Execute a shell command asynchronously in the background.",
    promptSnippet: "bg: Execute bash commands in background without blocking execution.",
    promptGuidelines: [
      "Use bg tool instead of bash for long-running shell commands, servers, builds, test suites, or tasks that take time to execute.",
    ],
    parameters: Type.Object({
      command: Type.String({ description: "Bash command to run in background" }),
      timeoutSec: Type.Optional(Type.Number({ minimum: 1, description: "Max run time in seconds before auto-kill (default: 600)" })),
    }),
    async execute(id, { command, timeoutSec = 600 }, _sig, _up, ctx) {
      return runBgProcess("bash", ["-c", command], command, timeoutSec, ctx);
    },
  });

  pi.registerTool({
    name: "subagent",
    description: "Delegate a task to an isolated background Pi process with optional model, thinking effort, system prompt, and tool restrictions.",
    promptSnippet: "subagent: Delegate specialized tasks to an isolated background subagent process.",
    promptGuidelines: [
      "Use subagent tool to delegate specialized research, code review, exploration, or parallel tasks to an isolated subagent with its own context window.",
    ],
    parameters: Type.Object({
      prompt: Type.String({ description: "Detailed task instructions for the subagent" }),
      description: Type.Optional(Type.String({ description: "Short (3-5 word) summary label for display in task manager" })),
      model: Type.Optional(Type.String({ description: "Preferred model pattern or ID; falls back to the parent model, then Pi's scoped/default models" })),
      thinking: Type.Optional(Type.String({ pattern: "^(off|minimal|low|medium|high|xhigh|max)$", description: "Thinking level" })),
      systemPrompt: Type.Optional(Type.String({ description: "Custom system prompt persona instructions for the subagent" })),
      tools: Type.Optional(Type.String({ description: "Comma-separated allowlist of tools for the subagent (e.g. 'read,grep,find,ls')" })),
      timeoutSec: Type.Optional(Type.Number({ minimum: 1, description: "Max run time in seconds before auto-kill (default: 600)" })),
    }),
    async execute(id, { prompt, description, model, thinking, systemPrompt, tools, timeoutSec = 600 }, _sig, _up, ctx) {
      const available = ctx.modelRegistry.getAvailable();
      const requested = model?.trim().toLowerCase();
      const requestedModel = requested
        ? available.find((m) => m.id.toLowerCase() === requested || `${m.provider}/${m.id}`.toLowerCase() === requested) ??
          available.find((m) => m.id.toLowerCase().includes(requested) || m.name?.toLowerCase().includes(requested))
        : undefined;
      const selected = requestedModel ??
        (ctx.model && available.find((m) => m.provider === ctx.model.provider && m.id === ctx.model.id));

      const args = ["-p"];
      if (selected) args.push("--model", `${selected.provider}/${selected.id}`);
      if (thinking) args.push("--thinking", thinking);
      if (systemPrompt) args.push("--system-prompt", systemPrompt);
      if (tools) args.push("--tools", tools);
      args.push(prompt);

      const label = description || (prompt.length > 30 ? `${prompt.slice(0, 30)}...` : prompt);
      const displayCmd = `Subagent: ${label}`;
      return runBgProcess("pi", args, displayCmd, timeoutSec, ctx);
    },
  });
}
