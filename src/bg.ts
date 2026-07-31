import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createLocalBashOperations,
  truncateTail,
} from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { JobManager } from "./manager.js";
import type { BgJob } from "./types.js";
import { getLogDir } from "./types.js";
import { renderToolResult, sanitizeTerminalOutput } from "./utils.js";

export function registerBgModule(pi: ExtensionAPI, manager: JobManager) {
  const MAX_CMD_LEN = 120;
  function runBgProcess(
    command: string,
    timeoutSec: number,
    ctx: ExtensionContext,
    completion: "queue" | "continue" = "continue",
  ) {
    const expectedGeneration = manager.generation;
    manager.guard(expectedGeneration);
    const safeCommand = sanitizeTerminalOutput(command);
    const shownCommand =
      safeCommand.length > MAX_CMD_LEN
        ? `${safeCommand.slice(0, MAX_CMD_LEN - 3)}...`
        : safeCommand;
    const pid = manager.nextVirtualPid++;
    const controller = new AbortController();
    const abortFromShutdown = () => controller.abort();
    if (manager.lifecycle.signal.aborted) controller.abort();
    else
      manager.lifecycle.signal.addEventListener("abort", abortFromShutdown, {
        once: true,
      });
    let output = "";
    let outputTruncated = false;
    const job: BgJob = {
      pid,
      command: shownCommand,
      startedAt: Date.now(),
      controller,
      kind: "shell",
      completion,
    };
    manager.jobs.set(pid, job);
    manager.syncStatus(ctx);

    // Drop stale launcher PI_* values first, then set this session's.
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of [
      "PI_SESSION_ID",
      "PI_SESSION_FILE",
      "PI_PROVIDER",
      "PI_MODEL",
      "PI_REASONING_LEVEL",
    ])
      delete env[key];
    env.PI_SESSION_ID = ctx.sessionManager.getSessionId();
    if (ctx.sessionManager.getSessionFile())
      env.PI_SESSION_FILE = ctx.sessionManager.getSessionFile();
    if (ctx.model) {
      env.PI_PROVIDER = ctx.model.provider;
      env.PI_MODEL = ctx.model.id;
    }
    if (ctx.thinkingLevel) env.PI_REASONING_LEVEL = ctx.thinkingLevel;

    manager.track(
      createLocalBashOperations()
        .exec(command, ctx.cwd, {
          signal: controller.signal,
          timeout: timeoutSec,
          env,
          onData(data) {
            const truncated = truncateTail(output + data.toString());
            outputTruncated ||= truncated.truncated;
            output = truncated.content;
          },
        })
        .then(({ exitCode }) => finish(exitCode))
        .catch((error) => finish(null, error)),
    );

    function finish(exitCode: number | null, error?: unknown) {
      manager.lifecycle.signal.removeEventListener("abort", abortFromShutdown);
      const message =
        error instanceof Error ? error.message : error ? String(error) : "";
      const timedOut = message.startsWith("timeout:");
      const cancelled = controller.signal.aborted && !timedOut;
      const failed = Boolean(error) && !cancelled && !timedOut;
      const content = sanitizeTerminalOutput(output.trim());
      const keepLog =
        cancelled || timedOut || failed || exitCode !== 0 || outputTruncated;
      let logFile = "";
      if (keepLog) {
        try {
          logFile = join(getLogDir(), `${randomUUID()}.log`);
          writeFileSync(logFile, content || message, { mode: 0o600 });
        } catch (logError) {
          console.warn(`Could not save background task log:`, logError);
          logFile = "";
        }
      }
      const heading = timedOut
        ? `Background task timed out after ${timeoutSec} seconds`
        : cancelled
          ? "Background task was stopped"
          : failed
            ? "Background task could not start"
            : exitCode === 0
              ? "Background task finished"
              : "Background task failed";
      const result = content
        ? `\n\nResult:\n${content}${outputTruncated ? `\n\nThe result was shortened. Retained tail: ${logFile}` : ""}`
        : "";
      const reason = failed
        ? `\n\nReason: ${message}`
        : exitCode
          ? `\n\nExit code: ${exitCode}`
          : "";
      if (!job.stoppedManually) {
        manager.deliverCompletion(
          `${heading}\nTask: ${shownCommand}${reason}${result}${keepLog ? `\n\nTroubleshooting log: ${logFile}` : ""}`,
          job.completion ?? "continue",
          expectedGeneration,
        );
      }
      manager.jobs.delete(pid);
      manager.syncStatus(ctx);
    }

    return {
      content: [
        {
          type: "text" as const,
          text: `Started shell job ${pid}: ${shownCommand}\n${completion === "queue" ? "Result will be delivered on your next prompt (queue mode)." : "The result will arrive automatically. Continue other work; do not wait, sleep, or poll."} Use /bg to view or stop the task.`,
        },
      ],
      details: { pid },
    };
  }

  pi.registerCommand("bg", {
    description: "List and manage background jobs",
    getArgumentCompletions: (prefix) => {
      const items = Array.from(manager.jobs.values(), (job) => ({
        value: `kill ${job.pid}`,
        label: `kill ${job.pid}`,
        description: job.command,
      })).filter((item) => item.value.startsWith(prefix));
      return items.length ? items : null;
    },
    handler: async (args, ctx) => {
      manager.currentCtx = ctx;
      const trimmed = args?.trim() ?? "";
      const killMatch = trimmed.match(/^kill\s+(\d+)$/);
      if (killMatch) {
        const pid = Number(killMatch[1]);
        if (manager.killJob(pid)) {
          ctx.ui.notify(`Killed background job ${pid}`, "info");
          manager.syncStatus(ctx);
        } else {
          ctx.ui.notify(`No background job found with ID ${pid}`, "error");
        }
        return;
      }
      if (trimmed.startsWith("kill")) {
        ctx.ui.notify("Usage: /bg kill <pid>", "error");
        return;
      }
      if (trimmed) {
        ctx.ui.notify(
          `Unknown /bg command: ${sanitizeTerminalOutput(trimmed)}`,
          "error",
        );
        return;
      }

      if (ctx.hasUI) await manager.manageJobs(ctx);
    },
  });

  pi.registerTool({
    name: "bg",
    label: "Background",
    description:
      "Run, inspect, or stop long-running shell commands without blocking the agent session.",
    promptSnippet:
      "Run, inspect, or stop long-running shell commands without blocking the agent session.",
    promptGuidelines: [
      "Use bg for long-running processes (e.g. dev servers, builds, test suites, heavy installs, long background tasks) or when the user asks to run commands while continuing discussion.",
      "Use standard bash for quick commands with immediate output (e.g. ls, git status, file reads).",
      "After starting bg, continue work immediately; never wait, sleep, or poll for completion.",
    ],
    parameters: Type.Object({
      action: Type.Optional(
        StringEnum(["spawn", "status", "stop"] as const, {
          description: "Action (default: spawn)",
        }),
      ),
      command: Type.Optional(
        Type.String({ description: "Shell command for spawn" }),
      ),
      completion: Type.Optional(
        StringEnum(["queue", "continue"] as const, {
          description:
            "continue wakes the parent turn automatically when ready (default); queue waits for user's next message",
        }),
      ),
      pid: Type.Optional(Type.Number({ description: "Job ID for stop" })),
      timeoutSec: Type.Optional(
        Type.Number({
          minimum: 1,
          maximum: 2_147_483,
          description: "Timeout in seconds (default: 600)",
        }),
      ),
    }),
    async execute(
      _id,
      {
        action = "spawn",
        command,
        completion = "continue",
        pid,
        timeoutSec = 600,
      },
      _sig,
      _up,
      ctx,
    ) {
      manager.currentCtx = ctx;
      if (action === "status") {
        const listed = Array.from(manager.jobs.values()).filter(
          (job) => job.kind === "shell",
        );
        if (listed.length === 0) {
          return {
            content: [
              { type: "text" as const, text: "No shell jobs running." },
            ],
            details: { jobs: [] },
          };
        }
        const items = listed.map((job) => {
          const elapsed = Math.round((Date.now() - job.startedAt) / 1000);
          return `● [PID ${job.pid}] \`${job.command}\` (running, ${elapsed}s)`;
        });
        const text = items.join("\n");
        return {
          content: [{ type: "text" as const, text }],
          details: {
            jobs: listed.map((j) => ({
              pid: j.pid,
              command: j.command,
              startedAt: j.startedAt,
            })),
          },
        };
      }
      if (action === "stop") {
        const job = pid === undefined ? undefined : manager.jobs.get(pid);
        if (!job || job.kind !== "shell")
          throw new Error(`Shell job not found: ${pid ?? "missing pid"}`);
        manager.killJob(job.pid);
        return {
          content: [
            { type: "text" as const, text: `Stopped shell job ${pid}` },
          ],
          details: { pid },
        };
      }
      if (!command?.trim()) throw new Error("command is required for spawn");
      return runBgProcess(command.trim(), timeoutSec, ctx, completion);
    },
    renderCall(args, theme) {
      const action = args.action ?? "spawn";
      if (action === "status")
        return new Text(
          theme.fg("toolTitle", theme.bold("Background jobs status")),
          0,
          0,
        );
      if (action === "stop")
        return new Text(
          theme.fg(
            "toolTitle",
            theme.bold(`Stop background job ${args.pid ?? ""}`),
          ),
          0,
          0,
        );
      const cmd = sanitizeTerminalOutput(String(args.command || "..."));
      const completionTag =
        args.completion === "queue" ? theme.fg("dim", " [queue]") : "";
      return new Text(
        `${theme.fg("toolTitle", theme.bold(`$ bg: ${cmd}`))}${completionTag}`,
        0,
        0,
      );
    },
    renderResult(result, options, theme) {
      return renderToolResult(result, options, theme, 8);
    },
  });
}
