import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn } from "node:child_process";
import { openSync } from "node:fs";

export default function (pi: ExtensionAPI) {
  const pids = new Set<number>();

  function syncStatus(ctx: any) {
    ctx?.ui?.setStatus("bg-jobs", pids.size > 0 ? `${ctx.ui.theme.fg("accent", "⚙ ")}${pids.size} bg` : undefined);
  }

  pi.on("session_start", (_e, ctx) => {
    syncStatus(ctx);
    spawn("find", ["/tmp", "-name", "pi-bg-*.log", "-mtime", "+1", "-delete"], { detached: true, stdio: "ignore" }).unref();
  });

  pi.registerTool({
    name: "bg",
    description: "Run a long-running shell command in the background without blocking execution",
    parameters: Type.Object({
      command: Type.String({ description: "Bash command to run" }),
      timeoutSec: Type.Optional(Type.Number({ description: "Max run time in seconds before auto-kill (default: 600)" })),
    }),
    async execute(id, { command, timeoutSec = 600 }, _sig, _up, ctx) {
      if (!command?.trim()) throw new Error("Command cannot be empty");

      const logFile = `/tmp/pi-bg-${Date.now()}.log`;
      let out: number;
      try {
        out = openSync(logFile, "a");
      } catch (err: any) {
        throw new Error(`Failed to open log file: ${err.message}`);
      }

      let proc;
      try {
        proc = spawn("bash", ["-c", command], { cwd: ctx.cwd, detached: true, stdio: ["ignore", out, out] });
        proc.unref();
      } catch (err: any) {
        throw new Error(`Failed to spawn background command: ${err.message}`);
      }

      let timedOut = false;
      const timer = setTimeout(() => {
        if (proc.pid && pids.has(proc.pid)) {
          timedOut = true;
          try { process.kill(-proc.pid, "SIGKILL"); } catch { proc.kill("SIGKILL"); }
        }
      }, timeoutSec * 1000);

      if (proc.pid) {
        pids.add(proc.pid);
        syncStatus(ctx);
      }

      proc.on("exit", (code) => {
        clearTimeout(timer);
        if (proc.pid) pids.delete(proc.pid);
        syncStatus(ctx);

        const status = timedOut ? `TIMED OUT after ${timeoutSec}s` : `exit ${code}`;
        const msg = `[Background Job ${proc.pid}] ${status}. Command: "${command}". Log: ${logFile}`;
        pi.sendUserMessage(msg, { deliverAs: ctx?.isIdle?.() === false ? "followUp" : undefined });
      });

      return {
        content: [{ type: "text", text: `Command started in background [PID ${proc.pid}, max ${timeoutSec}s]. Log: ${logFile}` }],
        details: { pid: proc.pid, logFile },
      };
    },
  });
}
