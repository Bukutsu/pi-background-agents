import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn } from "node:child_process";
import { openSync } from "node:fs";

interface BgJob {
  pid: number;
  command: string;
  logFile: string;
  startedAt: number;
}

export default function (pi: ExtensionAPI) {
  const jobs = new Map<number, BgJob>();

  function syncStatus(ctx: any) {
    try {
      ctx?.ui?.setStatus("bg-jobs", jobs.size > 0 ? `${ctx.ui.theme.fg("accent", "⚙ ")}${jobs.size} bg` : undefined);
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

  pi.on("session_start", (_e, ctx) => {
    syncStatus(ctx);
    spawn("find", ["/tmp", "-name", "pi-bg-*.log", "-mtime", "+1", "-delete"], { detached: true, stdio: "ignore" }).unref();
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
        (j) => `[${j.pid}] ${j.command} (${Math.round((Date.now() - j.startedAt) / 1000)}s)`
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
      const logFile = `/tmp/pi-bg-${Date.now()}.log`;
      const out = openSync(logFile, "a");
      const proc = spawn("bash", ["-c", command], { cwd: ctx.cwd, detached: true, stdio: ["ignore", out, out] });
      proc.unref();

      let timedOut = false;
      const timer = setTimeout(() => {
        if (proc.pid && jobs.has(proc.pid)) {
          timedOut = true;
          killJob(proc.pid);
        }
      }, timeoutSec * 1000);

      if (proc.pid) {
        jobs.set(proc.pid, { pid: proc.pid, command, logFile, startedAt: Date.now() });
        syncStatus(ctx);
      }

      proc.on("exit", (code) => {
        clearTimeout(timer);
        if (proc.pid) jobs.delete(proc.pid);
        syncStatus(ctx);

        const status = timedOut ? `TIMED OUT after ${timeoutSec}s` : `exit ${code}`;
        const msg = `[Background Job ${proc.pid}] ${status}. Command: "${command}". Log: ${logFile}`;
        let isIdle = false;
        try { isIdle = ctx?.isIdle?.() ?? true; } catch {}
        try {
          pi.sendUserMessage(msg, { deliverAs: isIdle ? undefined : "followUp" });
        } catch {}
      });

      return {
        content: [{ type: "text", text: `Command started in background [PID ${proc.pid}, max ${timeoutSec}s]. Log: ${logFile}` }],
        details: { pid: proc.pid, logFile },
      };
    },
  });
}
