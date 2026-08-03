import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  Box,
  Text,
  visibleWidth,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import {
  SUBAGENT_DIR,
  SUBAGENT_SESSION_DIR,
  type BgJob,
  type SubagentRecord,
} from "./types.js";
import {
  createMarkdownComponent,
  ensurePrivateDir,
  extractTextContent,
  getScopedModels,
  processIsAlive,
  readIndex,
  sanitizeTerminalOutput,
  saveRecord,
  usageSince,
} from "./utils.js";

const BRAILLE = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const WIDGET_REFRESH_MS = 200;

export class JobManager {
  public jobs = new Map<number, BgJob>();
  public nextVirtualPid = 1;
  public currentCtx: ExtensionContext | undefined;
  public generation = 0;
  public shuttingDown = true;
  public lifecycle = new AbortController();
  public pending = new Set<Promise<void>>();
  private pendingSetups = new Set<AbortController>();
  private widgetTimer: ReturnType<typeof setInterval> | undefined;
  private pendingCompletions: Array<{
    message: string;
    completion: "queue" | "continue";
    expectedGeneration: number;
  }> = [];

  constructor(public pi: ExtensionAPI) {}

  public init() {
    // Ensure storage roots are private before anything writes into them
    // (SessionManager would otherwise create them with default perms).
    ensurePrivateDir(SUBAGENT_DIR);
    ensurePrivateDir(SUBAGENT_SESSION_DIR);

    for (const record of Object.values(readIndex())) {
      if (record.state === "running" && !processIsAlive(record.ownerPid)) {
        record.state = "interrupted";
        record.updatedAt = new Date().toISOString();
        saveRecord(record);
      }
    }

    this.registerMessageRenderer();
    this.registerLifecycleEvents();
  }

  private registerMessageRenderer() {
    this.pi.registerMessageRenderer(
      "pi-background-agents-result",
      (message, options, theme) => {
        const text = sanitizeTerminalOutput(
          extractTextContent(message.content),
        );
        if (!text.trim()) return undefined;

        const lines = text.trim().split("\n");
        const firstLine = lines[0] ?? "";
        const isError = [
          "Background task could not start",
          "Background task failed",
          "Background task timed out",
          "Background task was stopped",
          "Background subagent timed out",
          "Background subagent was stopped",
          "Background subagent failed",
        ].some((prefix) => firstLine.startsWith(prefix));

        const bgFn = isError
          ? (s: string) => theme.bg("toolErrorBg", s)
          : (s: string) => theme.bg("toolSuccessBg", s);

        const titleColor = isError ? "error" : "accent";
        const headerText = theme.fg(titleColor, theme.bold(firstLine));

        const bodyText = lines.slice(1).join("\n").trim();
        const box = new Box(1, 1, bgFn);
        box.addChild(new Text(headerText, 0, 0));

        if (bodyText) {
          if (options.expanded) {
            box.addChild(createMarkdownComponent(bodyText, theme));
          } else {
            const bodyLines = bodyText.split("\n");
            const preview = bodyLines.slice(0, 8).join("\n");
            const hidden = Math.max(0, bodyLines.length - 8);
            const hint =
              hidden > 0 ? `\n\n_${hidden} more lines (expand to view)_` : "";
            box.addChild(createMarkdownComponent(preview + hint, theme));
          }
        }
        return box;
      },
    );
  }

  private registerLifecycleEvents() {
    this.pi.on("session_start", (_e, ctx) => {
      this.generation++;
      this.shuttingDown = false;
      this.lifecycle = new AbortController();
      this.flushPendingCompletions(ctx);
      this.syncStatus(ctx);
    });

    this.pi.on("before_agent_start", (event, ctx) => {
      this.flushPendingCompletions(ctx);
      const scopedList = getScopedModels(ctx);
      if (scopedList.length > 0) {
        const modelsList = scopedList
          .map((s) => `\`${s.model.provider}/${s.model.id}\``)
          .join(", ");
        return {
          systemPrompt: `${event.systemPrompt}\n\nAvailable scoped subagent models: ${modelsList}`,
        };
      }
    });

    this.pi.on("session_shutdown", async () => {
      this.shuttingDown = true;
      this.lifecycle.abort();
      if (this.widgetTimer) {
        clearInterval(this.widgetTimer);
        this.widgetTimer = undefined;
      }
      for (const [pid, job] of this.jobs) {
        try {
          if (job.record) {
            job.record = {
              ...this.currentRecord(job),
              state: "interrupted",
              updatedAt: new Date().toISOString(),
              durationSec: Math.round((Date.now() - job.startedAt) / 1000),
            };
            saveRecord(job.record);
          }
        } catch (error) {
          console.warn(
            `Could not persist interrupted background job ${pid}:`,
            error,
          );
        } finally {
          this.killJob(pid);
        }
      }
      let shutdownTimeout: ReturnType<typeof setTimeout> | undefined;
      let shutdownTimedOut = false;
      const timeoutPromise = new Promise<void>((resolve) => {
        shutdownTimeout = setTimeout(() => {
          shutdownTimedOut = true;
          resolve();
        }, 10000);
        shutdownTimeout.unref();
      });
      try {
        await Promise.race([
          Promise.allSettled([...this.pending]),
          timeoutPromise,
        ]);
        if (shutdownTimedOut) {
          for (const job of this.jobs.values()) {
            if (job.kind === "subagent") {
              try {
                job.forceDispose?.();
              } catch {}
            }
          }
        }
      } finally {
        if (shutdownTimeout) clearTimeout(shutdownTimeout);
      }
      this.currentCtx = undefined;
    });
  }

  public syncStatus(ctx?: ExtensionContext) {
    if (this.shuttingDown) {
      if (this.widgetTimer) {
        clearInterval(this.widgetTimer);
        this.widgetTimer = undefined;
      }
      return;
    }
    const active = this.currentCtx ?? ctx;
    if (!active) return;

    const activeJobs = Array.from(this.jobs.values());
    if (activeJobs.length === 0) {
      active.ui.setWidget("bg-subagents", undefined);
      if (this.widgetTimer) {
        clearInterval(this.widgetTimer);
        this.widgetTimer = undefined;
      }
      return;
    }

    active.ui.setWidget(
      "bg-subagents",
      (_tui, theme) => {
        const frame =
          BRAILLE[Math.floor(Date.now() / WIDGET_REFRESH_MS) % BRAILLE.length];
        const bColor = (str: string) => theme.fg("dim", str);
        return {
          render(width: number) {
            const count = activeJobs.length;
            const innerWidth = Math.max(10, width - 2);
            const hasBg = activeJobs.some((j) => j.kind === "shell");
            const hasSub = activeJobs.some((j) => j.kind === "subagent");
            const kind =
              hasBg && hasSub ? "bg+sub" : hasSub ? "subagent" : "bg";
            const title = ` ${kind === "bg" ? "Background Jobs" : kind === "subagent" ? "Subagents" : "Jobs"} (${count}) `;
            const rightHint = hasBg ? " /bg " : "";
            const topFillLen = Math.max(
              0,
              innerWidth - visibleWidth(title) - visibleWidth(rightHint),
            );
            const top = truncateToWidth(
              bColor("╭") +
                theme.fg("accent", theme.bold(title)) +
                bColor("─".repeat(topFillLen)) +
                bColor(rightHint + "╮"),
              width,
            );

            const maxVisible = 3;
            const overflow = count > maxVisible;
            const visibleJobs = activeJobs.slice(0, overflow ? 2 : 3);

            const jobLines = visibleJobs.map((job) => {
              const elapsed = Math.round((Date.now() - job.startedAt) / 1000);
              const icon =
                job.kind === "shell"
                  ? theme.fg("accent", "⚡")
                  : theme.fg("success", "●");
              const progress = job.activity
                ? `, ${truncateToWidth(sanitizeTerminalOutput(job.activity), 24)}`
                : "";
              const badgeText = job.session?.model
                ? sanitizeTerminalOutput(
                    `${job.session.model.id}:${job.session.thinkingLevel}`,
                  )
                : job.kind === "subagent" && job.record?.model
                  ? sanitizeTerminalOutput(job.record.model)
                  : undefined;
              const kindTag = job.kind === "subagent" ? " [sub]" : "";
              const queueTag = job.completion === "queue" ? " Q" : "";
              const badge = badgeText
                ? ` [${badgeText}${queueTag}]`
                : queueTag || kindTag
                  ? `${kindTag}${queueTag ? " Q" : ""}`
                  : "";
              const prefix = ` ${icon} `;
              const meta = `${badge} ${theme.fg("dim", `(running, ${elapsed}s${progress})`)}`;
              const availForCmd = Math.max(
                0,
                innerWidth - visibleWidth(prefix) - visibleWidth(meta),
              );
              const command = sanitizeTerminalOutput(job.command);
              const truncatedCmd =
                visibleWidth(command) > availForCmd
                  ? truncateToWidth(command, availForCmd)
                  : command;
              const content = `${prefix}${truncatedCmd}${meta}`;
              const fill = " ".repeat(
                Math.max(0, innerWidth - visibleWidth(content)),
              );
              return (
                bColor("│") +
                truncateToWidth(content + fill, innerWidth) +
                bColor("│")
              );
            });

            if (overflow) {
              const hidden = count - 2;
              const content = ` ${theme.fg("accent", frame)} ${theme.fg("dim", `+${hidden} more running...`)}`;
              const fill = " ".repeat(
                Math.max(0, innerWidth - visibleWidth(content)),
              );
              jobLines.push(
                bColor("│") +
                  truncateToWidth(content + fill, innerWidth) +
                  bColor("│"),
              );
            }

            const bottom = bColor("╰" + "─".repeat(innerWidth) + "╯");
            // TUI requires every line to fit `width` (bottom border is the one
            // line not built against it; truncate defensively).
            return [top, ...jobLines, bottom].map((line) =>
              truncateToWidth(line, width),
            );
          },
          invalidate() {},
        };
      },
      { placement: "aboveEditor" },
    );

    if (!this.widgetTimer) {
      this.widgetTimer = setInterval(
        () => this.syncStatus(),
        WIDGET_REFRESH_MS,
      );
    }
  }

  private sendCompletionMessage(
    message: string,
    completion: "queue" | "continue",
    ctx: ExtensionContext,
  ) {
    this.pi.sendMessage(
      {
        customType: "pi-background-agents-result",
        content: sanitizeTerminalOutput(message),
        display: true,
      },
      completion === "queue"
        ? { deliverAs: "nextTurn" }
        : { deliverAs: "steer", triggerTurn: ctx.isIdle() },
    );
  }

  private flushPendingCompletions(ctx: ExtensionContext) {
    this.currentCtx = ctx;
    while (this.pendingCompletions.length > 0) {
      const item = this.pendingCompletions.shift()!;
      if (!this.shuttingDown && this.generation === item.expectedGeneration) {
        try {
          this.sendCompletionMessage(item.message, item.completion, ctx);
        } catch (error) {
          console.warn("Could not deliver pending bg result:", error);
        }
      }
    }
  }

  public guard(expectedGeneration: number) {
    if (
      this.shuttingDown ||
      this.generation !== expectedGeneration ||
      this.lifecycle.signal.aborted
    )
      throw new Error("Parent session ended during background setup");
  }

  public track(done: Promise<void>) {
    this.pending.add(done);
    // Catch on the finally chain so a rejecting job never leaves an
    // unhandled rejection behind.
    void done.finally(() => this.pending.delete(done)).catch(() => {});
    return done;
  }

  public deliverCompletion(
    message: string,
    completion: "queue" | "continue",
    expectedGeneration: number,
  ) {
    if (this.shuttingDown || this.generation !== expectedGeneration) return;
    const active = this.currentCtx;
    if (!active) {
      this.pendingCompletions.push({
        message,
        completion,
        expectedGeneration,
      });
      return;
    }
    try {
      this.sendCompletionMessage(message, completion, active);
    } catch (error) {
      console.warn("Could not deliver bg result:", error);
      this.pendingCompletions.push({
        message,
        completion,
        expectedGeneration,
      });
    }
  }

  public killJob(pid: number): boolean {
    const job = this.jobs.get(pid);
    if (!job || job.controller.signal.aborted) return false;
    job.stoppedManually = true;
    job.controller.abort();
    return true;
  }

  public trackSetup(controller: AbortController) {
    this.pendingSetups.add(controller);
    return () => this.pendingSetups.delete(controller);
  }

  public killAllJobs(): number {
    let stopped = 0;
    for (const pid of this.jobs.keys()) {
      if (this.killJob(pid)) stopped++;
    }
    for (const controller of this.pendingSetups) {
      if (!controller.signal.aborted) {
        controller.abort();
        stopped++;
      }
    }
    return stopped;
  }

  public currentRecord(job: BgJob): SubagentRecord {
    if (!job.session || !job.record || !job.baseline)
      throw new Error("currentRecord called on an incomplete job");
    const stats = job.session.getSessionStats();
    return {
      ...job.record,
      ...(job.session.model
        ? {
            model: `${job.session.model.provider}/${job.session.model.id}`,
            thinking: job.session.thinkingLevel,
          }
        : {}),
      turns: stats.assistantMessages - job.baseline.assistantMessages,
      toolCount: stats.toolCalls - job.baseline.toolCalls,
      toolFailures: job.toolFailures ?? 0,
      usage: usageSince(stats, job.baseline),
    };
  }

  public async manageJobs(ctx: ExtensionContext) {
    if (this.jobs.size === 0)
      return ctx.ui.notify("No background jobs running", "info");
    const choice = await ctx.ui.select("Select job to stop:", [
      "Cancel",
      "Stop all",
      ...Array.from(
        this.jobs.values(),
        (job) =>
          `[${job.pid}] ${job.command}${job.sessionId ? ` [session: ${job.sessionId.slice(0, 8)}]` : ""} (${Math.round((Date.now() - job.startedAt) / 1000)}s)`,
      ),
    ]);
    if (choice === "Stop all") {
      const stopped = this.killAllJobs();
      ctx.ui.notify(
        `Stopped ${stopped} background job${stopped === 1 ? "" : "s"}`,
        "info",
      );
      this.syncStatus(ctx);
      return;
    }
    const pid = Number(choice?.match(/\[(-?\d+)\]/)?.[1]);
    if (choice !== "Cancel" && Number.isInteger(pid) && this.killJob(pid)) {
      ctx.ui.notify(`Stopped background job ${pid}`, "info");
      this.syncStatus(ctx);
    }
  }
}
