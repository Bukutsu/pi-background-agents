import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn } from "node:child_process";
import { openSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
    try {
      if (process.platform === "win32") {
        try { process.kill(pid, "SIGKILL"); } catch { spawn("taskkill", ["/F", "/PID", String(pid), "/T"]); }
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
    description: "Execute a shell command asynchronously in the background. Use this instead of standard bash whenever running servers, builds, test suites, or long-running tasks so execution stays non-blocking.",
    promptSnippet: "bg: Execute bash commands in background without blocking execution.",
    promptGuidelines: [
      "Use bg tool instead of bash for long-running shell commands, servers, builds, test suites, or tasks that take time to execute.",
    ],
    parameters: Type.Object({
      command: Type.String({ description: "Bash command to run in background" }),
      timeoutSec: Type.Optional(Type.Number({ description: "Max run time in seconds before auto-kill (default: 600)" })),
    }),
    async execute(id, { command, timeoutSec = 600 }, _sig, _up, ctx) {
      const isWin = process.platform === "win32";
      const shell = isWin ? (process.env.ComSpec || "cmd.exe") : "bash";
      const args = isWin ? ["/d", "/s", "/c", command] : ["-c", command];
      return runBgProcess(shell, args, command, timeoutSec, ctx);
    },
  });

  pi.registerTool({
    name: "subagent",
    description: "Delegate a task to an isolated background subagent process with optional custom model, thinking effort, system prompt persona, and restricted tools. Use subagents for parallel research, code reviews, deep exploration, or heavy tasks to keep your main conversation context clean.",
    promptSnippet: "subagent: Delegate specialized tasks to an isolated background subagent process.",
    promptGuidelines: [
      "Use subagent tool to delegate specialized research, code review, exploration, or parallel tasks to an isolated subagent with its own context window.",
    ],
    parameters: Type.Object({
      prompt: Type.String({ description: "Detailed task instructions for the subagent" }),
      description: Type.Optional(Type.String({ description: "Short (3-5 word) summary label for display in task manager" })),
      model: Type.Optional(Type.String({ description: "Model pattern or ID (e.g. 'anthropic/claude-3-5-haiku', 'openai/gpt-4o-mini')" })),
      thinking: Type.Optional(Type.String({ description: "Thinking level: off, minimal, low, medium, high, xhigh, max" })),
      systemPrompt: Type.Optional(Type.String({ description: "Custom system prompt persona instructions for the subagent" })),
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
