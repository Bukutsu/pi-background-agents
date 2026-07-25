import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const LOG_DIR = join(tmpdir(), "pi-bg");
const MAX_TIMEOUT_SEC = 2_147_483;

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
        const result = spawnSync("taskkill", ["/F", "/PID", String(pid), "/T"], { stdio: "ignore" });
        return !result.error && result.status === 0;
      }
      try { process.kill(-pid, "SIGKILL"); } catch { process.kill(pid, "SIGKILL"); }
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
    ctx: any,
    cleanupFiles: string[] = []
  ) {
    mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
    const logFile = join(LOG_DIR, `${Date.now()}-${Math.random().toString(36).slice(2, 6)}.log`);
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
      let keepLog = code !== 0 || Boolean(spawnError);
      try {
        const content = readFileSync(logFile, "utf-8").trim();
        if (content.length > 2000) {
          const head = content.slice(0, 1000).replace(/\s+\S*$/, "");
          const tail = content.slice(-1000).replace(/^\S*\s+/, "");
          result = `\n\nResult:\n${head}\n\n[Middle omitted]\n\n${tail}\n\nThe result was shortened. Full result: ${logFile}`;
          keepLog = true;
        } else if (content) {
          result = `\n\nResult:\n${content}`;
        }
      } catch {}

      const reason = spawnError ? `\n\nReason: ${spawnError}` : code && code !== 0 ? `\n\nExit code: ${code}` : "";
      const troubleshooting = code === 0 ? "" : `\n\nTroubleshooting log: ${logFile}`;
      const msg = `${heading}\nTask: ${displayCommand}${reason}${result}${troubleshooting}`;
      let isIdle = false;
      try { isIdle = ctx.isIdle(); } catch {}
      try {
        pi.sendMessage(
          { customType: "pi-bg-result", content: msg, display: true },
          isIdle ? undefined : { deliverAs: "followUp" },
        );
        if (!keepLog) unlinkSync(logFile);
      } catch (error) {
        console.error(`pi-bg could not deliver a result. Full result: ${logFile}`, error);
      }
      for (const file of cleanupFiles) try { unlinkSync(file); } catch {}
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
      for (const file of readdirSync(LOG_DIR)) {
        const fullPath = join(LOG_DIR, file);
        try {
          if (now - statSync(fullPath).mtimeMs > 86_400_000) unlinkSync(fullPath);
        } catch {}
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
      timeoutSec: Type.Optional(Type.Number({ minimum: 1, maximum: MAX_TIMEOUT_SEC, description: "Max run time in seconds before auto-kill (default: 600)" })),
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
      timeoutSec: Type.Optional(Type.Number({ minimum: 1, maximum: MAX_TIMEOUT_SEC, description: "Max run time in seconds before auto-kill (default: 600)" })),
    }),
    async execute(id, { prompt, description, model, thinking, systemPrompt, tools, timeoutSec = 600 }, _sig, _up, ctx) {
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

      const args = ["-p", "--no-session"];
      const cleanupFiles: string[] = [];
      if (selected) args.push("--model", `${selected.provider}/${selected.id}`);
      if (thinking) args.push("--thinking", thinking);
      if (systemPrompt) {
        mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
        const promptFile = join(LOG_DIR, `prompt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.md`);
        writeFileSync(promptFile, systemPrompt, { mode: 0o600, flag: "wx" });
        cleanupFiles.push(promptFile);
        args.push("--append-system-prompt", promptFile);
      }
      if (tools) args.push("--tools", tools);
      args.push(prompt);

      const label = description || (prompt.length > 30 ? `${prompt.slice(0, 30)}...` : prompt);
      const displayCmd = `Subagent: ${label}`;
      const [file, invocationArgs] = getPiInvocation(args);
      try {
        return runBgProcess(file, invocationArgs, displayCmd, timeoutSec, ctx, cleanupFiles);
      } catch (error) {
        for (const file of cleanupFiles) try { unlinkSync(file); } catch {}
        throw error;
      }
    },
  });
}
