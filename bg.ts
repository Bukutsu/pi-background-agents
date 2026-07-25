import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn } from "node:child_process";
import { openSync, readFileSync } from "node:fs";

interface BgJob {
  pid: number;
  command: string;
  logFile: string;
  startedAt: number;
}

export default function (pi: ExtensionAPI) {
  const jobs = new Map<number, BgJob>();
  let lastCtx: any = null;

  function syncStatus(ctx?: any) {
    if (ctx) lastCtx = ctx;
    const currentCtx = lastCtx;
    if (!currentCtx) return;

    try {
      currentCtx?.ui?.setStatus("bg-jobs", jobs.size > 0 ? `${currentCtx.ui.theme.fg("accent", "● ")}${jobs.size} bg` : undefined);
    } catch {}
  }

  function killJob(pid: number): boolean {
    if (!jobs.has(pid)) return false;
    try { process.kill(-pid, "SIGKILL"); } catch {
      try { process.kill(pid, "SIGKILL"); } catch {}
    }
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
    const logFile = `/tmp/pi-bg-${Date.now()}.log`;
    const out = openSync(logFile, "a");
    const proc = spawn(file, args, { cwd: ctx.cwd, detached: true, stdio: ["ignore", out, out] });
    proc.unref();

    let timedOut = false;
    const timer = setTimeout(() => {
      if (proc.pid && jobs.has(proc.pid)) {
        timedOut = true;
        killJob(proc.pid);
      }
    }, timeoutSec * 1000);

    if (proc.pid) {
      jobs.set(proc.pid, { pid: proc.pid, command: displayCommand, logFile, startedAt: Date.now() });
      syncStatus(ctx);
    }

    proc.on("exit", (code, signal) => {
      clearTimeout(timer);
      if (proc.pid) jobs.delete(proc.pid);
      syncStatus(ctx);

      const status = timedOut
        ? `TIMED OUT after ${timeoutSec}s`
        : code !== null
        ? `exit ${code}`
        : `killed (${signal})`;
      let outputSnippet = "";
      if (code === 0) {
        try {
          const content = readFileSync(logFile, "utf-8").trim();
          if (content) {
            outputSnippet = `\nOutput:\n${content.length > 2000 ? content.slice(-2000) : content}`;
          }
        } catch {}
      }

      const msg = `[Background Job ${proc.pid}] ${status}. Command: "${displayCommand}". Log: ${logFile}${outputSnippet}`;
      let isIdle = false;
      try { isIdle = ctx?.isIdle?.() ?? true; } catch {}
      try {
        pi.sendUserMessage(msg, { deliverAs: isIdle ? undefined : "followUp" });
      } catch {}
    });

    return {
      content: [{ type: "text", text: `Job started in background [PID ${proc.pid}, max ${timeoutSec}s]. Log: ${logFile}` }],
      details: { pid: proc.pid, logFile },
    };
  }

  pi.on("session_start", (_e, ctx) => {
    syncStatus(ctx);
    spawn("find", ["/tmp", "-name", "pi-bg-*.log", "-mtime", "+1", "-delete"], { detached: true, stdio: "ignore" }).unref();
  });

  pi.on("session_shutdown", () => {
    for (const pid of Array.from(jobs.keys())) {
      killJob(pid);
    }
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

      if (!ctx.hasUI) {
        ctx.ui.notify(`Running background jobs:\n${items.join("\n")}`, "info");
        return;
      }

      const choice = await ctx.ui.select("Select job to stop:", ["Cancel", ...items]);
      if (choice && choice !== "Cancel") {
        const match = choice.match(/^\[(\d+)\]/);
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
    description: "Run a long-running shell command in the background without blocking execution",
    parameters: Type.Object({
      command: Type.String({ description: "Bash command to run" }),
      timeoutSec: Type.Optional(Type.Number({ description: "Max run time in seconds before auto-kill (default: 600)" })),
    }),
    async execute(id, { command, timeoutSec = 600 }, _sig, _up, ctx) {
      return runBgProcess("bash", ["-c", command], command, timeoutSec, ctx);
    },
  });

  pi.registerTool({
    name: "subagent",
    description: "Delegate a task to a background subagent with optional model and effort (thinking level)",
    parameters: Type.Object({
      prompt: Type.String({ description: "Task prompt for the subagent" }),
      description: Type.Optional(Type.String({ description: "Short (3-5 word) summary description for display in task manager" })),
      model: Type.Optional(Type.String({ description: "Model pattern or ID (e.g. 'anthropic/claude-3-5-haiku', 'openai/gpt-4o-mini')" })),
      thinking: Type.Optional(Type.String({ description: "Thinking level: off, minimal, low, medium, high, xhigh, max" })),
      systemPrompt: Type.Optional(Type.String({ description: "Custom system prompt for the subagent" })),
      tools: Type.Optional(Type.String({ description: "Comma-separated allowlist of tools for the subagent (e.g. 'read,grep,find,ls')" })),
      timeoutSec: Type.Optional(Type.Number({ description: "Max run time in seconds before auto-kill (default: 600)" })),
    }),
    async execute(id, { prompt, description, model, thinking, systemPrompt, tools, timeoutSec = 600 }, _sig, _up, ctx) {
      const args = ["-p"];
      if (model) args.push("--model", model);
      if (thinking) args.push("--thinking", thinking);
      if (systemPrompt) args.push("--system-prompt", systemPrompt);
      if (tools) args.push("--tools", tools);
      args.push(prompt);

      const label = description || (prompt.length > 30 ? `${prompt.slice(0, 30)}...` : prompt);
      const displayCmd = `pi subagent: "${label}"`;
      return runBgProcess("pi", args, displayCmd, timeoutSec, ctx);
    },
  });
}
