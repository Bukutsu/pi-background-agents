import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  createAgentSession,
  ModelRuntime,
  resolveCliModel,
  SessionManager,
  truncateTail,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { JobManager } from "./manager.js";
import {
  getLogDir,
  SUBAGENT_INDEX,
  SUBAGENT_SESSION_DIR,
  type BgJob,
  type SubagentRecord,
  type TerminalState,
} from "./types.js";
import {
  acquireSessionLock,
  getScopedModels,
  getSubagentHeading,
  readIndex,
  renderToolResult,
  resolveSubagentCwd,
  sanitizeForkMessages,
  saveRecord,
  STATE_ICONS,
} from "./utils.js";
import { createWorktree } from "./worktree.js";

export function registerSubagentModule(pi: ExtensionAPI, manager: JobManager) {
  let modelRuntime: Promise<ModelRuntime> | undefined;

  function statusDetails(record: SubagentRecord, job?: BgJob) {
    const current = job ? manager.currentRecord(job) : record;
    const { ownerPid: _, ...details } = current;
    return {
      ...details,
      ...(job?.activity ? { activity: job.activity } : {}),
      ...(job
        ? { elapsedSec: Math.round((Date.now() - job.startedAt) / 1000) }
        : {}),
    };
  }

  function formatSubagentStatusTable(
    sessions: Array<ReturnType<typeof statusDetails>>,
  ) {
    if (sessions.length === 0) return "No matching subagent sessions.";

    const cards = sessions.map((s) => {
      const icon = STATE_ICONS[s.state] ?? "•";
      const duration =
        s.elapsedSec !== undefined
          ? `${s.elapsedSec}s`
          : s.durationSec !== undefined
            ? `${s.durationSec}s`
            : undefined;
      const durationStr = duration ? ` | ${duration}` : "";
      const costText = s.usage.cost ? ` | $${s.usage.cost.toFixed(4)}` : "";
      const shortId = s.sessionId.slice(0, 8);
      const activityStr =
        s.activity ??
        `${s.turns} turn${s.turns === 1 ? "" : "s"}, ${s.toolCount} tool${s.toolCount === 1 ? "" : "s"}`;

      const thinkingStr = s.thinking ? `:${s.thinking}` : "";
      return `${icon} ${s.state}  ${s.label}
  Model: \`${s.model}${thinkingStr}\` | Session: \`${shortId}\`${durationStr}${costText}
  Activity: ${activityStr}`;
    });

    return cards.join("\n\n");
  }

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description:
      "Delegate exploration or research tasks to a background subagent.",
    promptSnippet:
      "Delegate exploration or research tasks to a background subagent.",
    promptGuidelines: [
      "Use subagent for multi-step sub-tasks, background research, code audits, refactoring, or sub-problems to keep main context uncluttered.",
      "Choose appropriate models for subagents based on task requirements (e.g. fast/inexpensive models for simple searches or checks, strong reasoning models with thinking for complex refactoring).",
      "Provide complete and self-contained instructions in prompt; use context:fork only when the child needs the parent's current conversation.",
      "Reuse sessionId from an earlier subagent result to continue its saved model, thinking level, cwd, and conversation.",
      "For high-level or non-technical requests ('check performance', 'audit security', 'investigate codebase'), delegate isolated sub-tasks to subagent.",
      "For independent tasks, call subagent multiple times in one turn; Pi runs them concurrently.",
      "Use worktree:true for concurrent writing subagents; pi-background-agents creates but never merges or removes the branch/worktree.",
      "After starting subagent, continue work immediately; never wait, sleep, or poll action:status for completion. Results arrive automatically.",
    ],
    parameters: Type.Object({
      action: Type.Optional(
        StringEnum(["spawn", "status", "steer", "stop"] as const, {
          description: "Action (default: spawn)",
        }),
      ),
      prompt: Type.Optional(Type.String({ description: "Task for spawn" })),
      description: Type.Optional(
        Type.String({ description: "Short job label" }),
      ),
      sessionId: Type.Optional(
        Type.String({
          description:
            "Durable session identity to resume, inspect, steer, or stop",
        }),
      ),
      message: Type.Optional(
        Type.String({
          description: "Message queued after the running child's current turn",
        }),
      ),
      completion: Type.Optional(
        StringEnum(["queue", "continue"] as const, {
          description:
            "continue wakes the parent turn automatically when ready (default); queue waits for user's next message",
        }),
      ),
      model: Type.Optional(
        Type.String({
          description:
            "Preferred model; omitted on resume to restore the saved model",
        }),
      ),
      thinking: Type.Optional(
        StringEnum(
          ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const,
          {
            description:
              "Thinking level; omitted on resume to restore the saved level",
          },
        ),
      ),
      tools: Type.Optional(
        Type.String({
          description:
            "Comma-separated tool allowlist; can only narrow the parent's active tools",
        }),
      ),
      cwd: Type.Optional(
        Type.String({
          description:
            "Existing working directory; cannot be combined with worktree:true",
        }),
      ),
      worktree: Type.Optional(
        Type.Boolean({
          description:
            "Create a unique persistent Git branch/worktree for a new session",
        }),
      ),
      context: Type.Optional(
        StringEnum(["project", "fork"] as const, {
          description:
            "project starts fresh with project resources (default); fork seeds sanitized parent conversation",
        }),
      ),
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
        prompt,
        description,
        sessionId,
        message,
        completion = "continue",
        model,
        thinking,
        tools,
        cwd,
        worktree = false,
        context = "project",
        timeoutSec = 600,
      },
      signal,
      _up,
      ctx,
    ) {
      manager.currentCtx = ctx;
      const requestedId = sessionId?.trim();
      const durable = readIndex();
      const findActiveSubagent = (id: string) =>
        Array.from(manager.jobs.values()).find(
          (job) =>
            job.kind === "subagent" &&
            (job.sessionId === id || job.sessionId?.startsWith(id)),
        );
      const findDurableRecord = (id: string) =>
        durable[id] ??
        Object.values(durable).find((r) => r.sessionId.startsWith(id));

      const matching = requestedId
        ? findActiveSubagent(requestedId)
        : undefined;
      if (action === "status") {
        const active = new Map(
          Array.from(manager.jobs.values())
            .filter((job) => job.kind === "subagent" && job.record)
            .map((job) => [job.sessionId!, job]),
        );
        const requestedRecord = requestedId
          ? (active.get(requestedId)?.record ??
            Array.from(active.values()).find((j) =>
              j.sessionId?.startsWith(requestedId),
            )?.record ??
            findDurableRecord(requestedId))
          : undefined;
        const records = requestedId
          ? requestedRecord
            ? [requestedRecord]
            : []
          : [
              ...Array.from(active.values(), (job) => job.record!),
              ...Object.values(durable)
                .filter((record) => !active.has(record.sessionId))
                .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
                .slice(0, 5),
            ];
        const sessions = records.map((record) =>
          statusDetails(record, active.get(record.sessionId)),
        );
        const text = formatSubagentStatusTable(sessions);
        return {
          content: [{ type: "text" as const, text }],
          details: { sessions },
        };
      }
      if (action === "stop") {
        if (!matching)
          throw new Error(
            `Running subagent not found: ${requestedId || "missing sessionId"}`,
          );
        manager.killJob(matching.pid);
        manager.syncStatus(ctx);
        return {
          content: [
            {
              type: "text" as const,
              text: `Stopped subagent ${matching.sessionId}`,
            },
          ],
          details: { sessionId: matching.sessionId },
        };
      }
      if (action === "steer") {
        if (!matching?.session)
          throw new Error(
            `Running subagent not found: ${requestedId || "missing sessionId"}`,
          );
        if (!message?.trim()) throw new Error("message is required for steer");
        try {
          await matching.session.steer(message.trim());
        } catch (error) {
          if (!manager.jobs.has(matching.pid))
            throw new Error(`Subagent ${matching.sessionId} already finished`);
          throw error;
        }
        return {
          content: [
            {
              type: "text" as const,
              text: `Queued steering for subagent ${matching.sessionId} after its current turn`,
            },
          ],
          details: { sessionId: matching.sessionId, queued: true },
        };
      }
      if (!prompt?.trim()) throw new Error("prompt is required for spawn");
      const expectedGeneration = manager.generation;
      manager.guard(expectedGeneration);
      const setupSignal = AbortSignal.any([
        ...(signal ? [signal] : []),
        manager.lifecycle.signal,
      ]);
      const checkSetup = () => {
        manager.guard(expectedGeneration);
        if (setupSignal.aborted)
          throw new Error("Subagent setup was cancelled");
      };
      prompt = prompt.trim();
      if (requestedId && matching)
        throw new Error(`Subagent session ${requestedId} is already running`);
      if (worktree && cwd !== undefined)
        throw new Error("cwd cannot be combined with worktree:true");
      if (requestedId && worktree)
        throw new Error(
          "worktree:true is only valid for a new subagent session",
        );
      if (requestedId && context === "fork")
        throw new Error(
          "context:fork is only valid for a new subagent session",
        );

      const existing = requestedId ? findDurableRecord(requestedId) : undefined;
      if (requestedId && !existing)
        throw new Error(
          `Subagent session not found in ${SUBAGENT_INDEX}: ${requestedId}`,
        );
      if (
        existing &&
        (!existsSync(existing.cwd) || !statSync(existing.cwd).isDirectory())
      ) {
        throw new Error(
          `Cannot resume subagent ${requestedId}: saved cwd${existing.branch ? "/worktree" : ""} is missing or deleted: ${existing.cwd}`,
        );
      }
      if (existing && !existsSync(existing.sessionFile))
        throw new Error(
          `Cannot resume subagent ${requestedId}: session file is missing or deleted: ${existing.sessionFile}`,
        );

      let branch: string | undefined;
      let childCwd: string;
      if (existing) {
        childCwd = resolveSubagentCwd(ctx.cwd, existing.cwd);
        if (cwd && resolveSubagentCwd(ctx.cwd, cwd) !== childCwd)
          throw new Error(
            `cwd does not match the saved subagent cwd: ${childCwd}`,
          );
        branch = existing.branch;
      } else if (worktree) {
        const created = await createWorktree(pi, ctx, setupSignal);
        childCwd = created.path;
        branch = created.branch;
        checkSetup();
      } else {
        childCwd = resolveSubagentCwd(ctx.cwd, cwd);
      }

      modelRuntime ??= ModelRuntime.create();
      const runtime = await modelRuntime;
      checkSetup();
      const forwardedProviders = new Set<string>();

      for (const providerId of ctx.modelRegistry.getRegisteredProviderIds()) {
        if (forwardedProviders.has(providerId)) continue;
        const native =
          ctx.modelRegistry.getRegisteredNativeProvider(providerId);
        const config =
          ctx.modelRegistry.getRegisteredProviderConfig(providerId);
        if (native) {
          runtime.registerNativeProvider(native);
          forwardedProviders.add(providerId);
        } else if (config) {
          runtime.registerProvider(providerId, config);
          forwardedProviders.add(providerId);
        } else {
          const provider = ctx.modelRegistry.getProvider(providerId);
          if (provider) {
            runtime.registerNativeProvider(provider);
            forwardedProviders.add(providerId);
          }
        }
      }

      const modelSpec = model?.trim();
      let resolvedModel: any | undefined;
      let resolvedThinking: any | undefined;

      const scopedList = getScopedModels(ctx);
      if (modelSpec) {
        if (scopedList && scopedList.length > 0) {
          const lowerSpec = modelSpec.toLowerCase();
          const exact = scopedList.find(
            (s) =>
              `${s.model.provider}/${s.model.id}`.toLowerCase() === lowerSpec ||
              s.model.id.toLowerCase() === lowerSpec,
          );
          const matched =
            exact ??
            scopedList.find(
              (s) =>
                s.model.id.toLowerCase().includes(lowerSpec) ||
                (s.model.name &&
                  String(s.model.name).toLowerCase().includes(lowerSpec)) ||
                s.model.provider.toLowerCase().includes(lowerSpec),
            );
          if (matched) {
            resolvedModel = matched.model;
            resolvedThinking = thinking ?? matched.thinkingLevel;
          } else {
            const availableNames = scopedList
              .map((s) => `${s.model.provider}/${s.model.id}`)
              .join(", ");
            throw new Error(
              `Requested model '${modelSpec}' is not in the active model scope. Available scoped models: ${availableNames}`,
            );
          }
        } else {
          const resolved = resolveCliModel({
            cliModel: modelSpec,
            cliThinking: thinking,
            modelRuntime: runtime,
          });
          if (resolved.error) throw new Error(resolved.error);
          if (resolved.warning) console.warn(resolved.warning);
          resolvedModel = resolved.model;
          resolvedThinking = thinking ?? resolved.thinkingLevel;
        }
      }

      const parentTools = pi
        .getActiveTools()
        .filter((name) => name !== "bg" && name !== "subagent");
      const requestedTools = tools
        ?.split(",")
        .map((tool) => tool.trim())
        .filter(Boolean);
      const unknownTools =
        requestedTools?.filter((tool) => !parentTools.includes(tool)) ?? [];
      if (unknownTools.length)
        throw new Error(
          `Tools are not active in the parent session: ${unknownTools.join(", ")}`,
        );
      const childTools = requestedTools ?? parentTools;

      mkdirSync(SUBAGENT_SESSION_DIR, { recursive: true, mode: 0o700 });
      const sessionManager = existing
        ? SessionManager.open(
            existing.sessionFile,
            SUBAGENT_SESSION_DIR,
            childCwd,
          )
        : SessionManager.create(
            childCwd,
            SUBAGENT_SESSION_DIR,
            context === "fork"
              ? { parentSession: ctx.sessionManager.getSessionFile() }
              : undefined,
          );
      if (!existing && context === "fork")
        for (const parentMessage of sanitizeForkMessages(ctx))
          sessionManager.appendMessage(parentMessage);
      const requestedThinking = thinking ?? resolvedThinking;
      const scopedEntry =
        !resolvedModel && !existing
          ? (scopedList?.find(
              (s) =>
                s.model.id === ctx.model?.id &&
                s.model.provider === ctx.model?.provider,
            ) ?? scopedList?.[0])
          : undefined;
      const selectedModel =
        resolvedModel ??
        (!existing ? (scopedEntry?.model ?? ctx.model) : undefined);
      const effectiveThinking =
        requestedThinking ??
        (!existing
          ? (scopedEntry?.thinkingLevel ?? ctx.thinkingLevel)
          : undefined);
      checkSetup();
      const targetSessionId =
        existing?.sessionId ?? sessionManager.getSessionId();
      const sessionLock = acquireSessionLock(targetSessionId);
      let created: Awaited<ReturnType<typeof createAgentSession>> | undefined;
      try {
        created = await createAgentSession({
          cwd: childCwd,
          tools: childTools,
          excludeTools: ["bg", "subagent"],
          modelRuntime: runtime,
          sessionManager,
          ...(selectedModel ? { model: selectedModel } : {}),
          ...(!existing
            ? { thinkingLevel: effectiveThinking }
            : requestedThinking
              ? { thinkingLevel: requestedThinking }
              : {}),
        });
        checkSetup();
      } catch (error) {
        if (created) await created.session.dispose();
        rmSync(sessionLock, { recursive: true, force: true });
        throw error;
      }
      const { session, modelFallbackMessage, extensionsResult } = created!;
      const controller = new AbortController();
      let extensionsBound = false;
      let disposed = false;
      const disposeChild = async () => {
        if (disposed) return;
        disposed = true;
        try {
          if (extensionsBound) {
            try {
              await session.extensionRunner.emit({
                type: "session_shutdown",
                reason: "quit",
              });
            } catch {}
          }
          await session.dispose();
        } catch {}
        try {
          rmSync(sessionLock, { recursive: true, force: true });
        } catch {}
      };
      try {
        checkSetup();
        extensionsBound = true;
        await session.bindExtensions({
          mode: "print",
          abortHandler: () => void session.abort(),
          shutdownHandler: () => controller.abort(),
          onError: (error) =>
            console.warn(`Subagent extension error: ${error.error}`),
        });
        checkSetup();
        if (controller.signal.aborted)
          throw new Error("Subagent extension requested shutdown during setup");
        for (const error of extensionsResult.errors)
          console.warn(
            `Subagent extension failed to load ${error.path}: ${error.error}`,
          );
      } catch (error) {
        await disposeChild();
        throw error;
      }

      if (!session.model) {
        await disposeChild();
        throw new Error("Subagent session did not initialize a model");
      }
      const actualTools = session
        .getActiveToolNames()
        .filter((name) => name !== "bg" && name !== "subagent");
      const missingTools =
        requestedTools?.filter((name) => !actualTools.includes(name)) ?? [];
      if (missingTools.length) {
        await disposeChild();
        throw new Error(
          `Requested tools were not available in the child: ${missingTools.join(", ")}`,
        );
      }
      try {
        if (!existing) {
          sessionManager.appendCustomEntry("pi-background-agents", {
            createdAt: new Date().toISOString(),
          });
          if (context === "fork")
            sessionManager.appendModelChange(
              session.model.provider,
              session.model.id,
            );
        }
      } catch (error) {
        await disposeChild();
        throw error;
      }
      const sessionFile =
        session.sessionFile ?? sessionManager.getSessionFile();
      if (!sessionFile) {
        await disposeChild();
        throw new Error(
          "Subagent session did not initialize a persistent session path",
        );
      }

      const pid = manager.nextVirtualPid--;
      let timedOut = false;
      let cancelled = false;
      let partialAssistant: any;
      const runAssistants: any[] = [];
      if (controller.signal.aborted) {
        cancelled = !timedOut;
        void session.abort().catch(() => {});
      } else {
        controller.signal.addEventListener(
          "abort",
          () => {
            cancelled = !timedOut;
            void session.abort().catch(() => {});
          },
          { once: true },
        );
      }
      const label =
        description?.trim() ||
        (prompt.length > 30 ? `${prompt.slice(0, 30)}...` : prompt);
      const displayModel = `${session.model.provider}/${session.model.id}`;
      const fallback = modelFallbackMessage
        ? `\nModel fallback: ${modelFallbackMessage}`
        : "";
      const now = new Date().toISOString();
      const record: SubagentRecord = {
        sessionId: session.sessionId,
        cwd: childCwd,
        sessionFile,
        model: displayModel,
        thinking: session.thinkingLevel,
        label,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        state: "running",
        turns: 0,
        toolCount: 0,
        toolFailures: 0,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
          cost: 0,
        },
        inheritedTools: actualTools,
        branch,
        context: existing?.context ?? context,
        ownerPid: process.pid,
      };
      const job: BgJob = {
        pid,
        command: `Subagent: ${label}`,
        startedAt: Date.now(),
        sessionId: session.sessionId,
        controller,
        kind: "subagent",
        session,
        activity: "starting",
        completion,
        baseline: session.getSessionStats(),
        record,
        toolFailures: 0,
        activeTools: new Map(),
        sessionLock,
      };
      try {
        manager.jobs.set(pid, job);
        saveRecord(record);
      } catch (error) {
        manager.jobs.delete(pid);
        await disposeChild();
        throw error;
      }

      const setActivity = (activity: string) => {
        if (job.activity === activity) return;
        job.activity = activity;
        manager.syncStatus(ctx);
      };
      const unsubscribe = session.subscribe((event) => {
        if (
          event.type === "message_update" &&
          event.message.role === "assistant"
        )
          partialAssistant = event.message;
        if (event.type === "message_end" && event.message.role === "assistant")
          runAssistants.push(event.message);
        if (event.type === "turn_start") setActivity("thinking");
        else if (
          event.type === "message_update" &&
          event.assistantMessageEvent.type === "text_delta" &&
          !job.activeTools!.size
        )
          setActivity("responding");
        else if (event.type === "tool_execution_start") {
          job.activeTools!.set(event.toolCallId, event.toolName);
          setActivity(`tool: ${[...job.activeTools!.values()].join(", ")}`);
        } else if (event.type === "tool_execution_end") {
          job.activeTools!.delete(event.toolCallId);
          if (event.isError) job.toolFailures!++;
          setActivity(
            job.activeTools!.size
              ? `tool: ${[...job.activeTools!.values()].join(", ")}`
              : event.isError
                ? `tool failed: ${event.toolName}`
                : "thinking",
          );
        }
      });
      manager.syncStatus(ctx);
      const timer = setTimeout(() => {
        if (!controller.signal.aborted) {
          timedOut = true;
          controller.abort();
        }
      }, timeoutSec * 1000);
      const done = (async () => {
        try {
          let thrown: string | undefined;
          try {
            await session.prompt(prompt);
          } catch (error) {
            thrown = error instanceof Error ? error.message : String(error);
          }
          const assistant = runAssistants.at(-1) ?? partialAssistant;
          const stopped = cancelled || assistant?.stopReason === "aborted";
          const failed = Boolean(
            thrown ||
            assistant?.errorMessage ||
            assistant?.stopReason === "error",
          );
          const state: TerminalState = timedOut
            ? "timed-out"
            : stopped
              ? "stopped"
              : failed
                ? "failed"
                : "finished";
          let reason = thrown ?? assistant?.errorMessage;
          const rawText = Array.isArray(assistant?.content)
            ? assistant.content
                .filter(
                  (part: any) =>
                    part?.type === "text" && typeof part.text === "string",
                )
                .map((part: any) => part.text)
                .join("\n")
                .trim()
            : "";
          const truncated = truncateTail(rawText);
          let truncationNote = "";
          if (truncated.truncated) {
            const logFile = join(getLogDir(), `${randomUUID()}.log`);
            try {
              writeFileSync(logFile, rawText, { mode: 0o600 });
              truncationNote = `\n\nResult truncated; full output: ${logFile}`;
            } catch (logError) {
              console.warn(`Could not save full subagent output:`, logError);
              truncationNote =
                "\n\nResult truncated; full output remains in the durable session file.";
            }
          }
          if (
            !manager.shuttingDown &&
            manager.generation === expectedGeneration
          ) {
            job.record = {
              ...manager.currentRecord(job),
              state,
              durationSec: Math.round((Date.now() - job.startedAt) / 1000),
              updatedAt: new Date().toISOString(),
            };
            try {
              saveRecord(job.record);
            } catch (recordError) {
              console.warn(`Could not save final subagent state:`, recordError);
              reason ??= `Could not save final subagent state: ${recordError instanceof Error ? recordError.message : String(recordError)}`;
            }
          }
          const completedRecord = job.record;
          if (!completedRecord)
            throw new Error(
              `Missing durable record for subagent ${session.sessionId}`,
            );
          const usage = completedRecord.usage;
          const costText = usage.cost ? `, $${usage.cost.toFixed(4)}` : "";
          const badge = `\n\n— Subagent ${state} (${completedRecord.durationSec ?? 0}s, ${completedRecord.turns} turn${completedRecord.turns === 1 ? "" : "s"}, ${completedRecord.toolCount} tool${completedRecord.toolCount === 1 ? "" : "s"}${costText}) • Session: ${session.sessionId}`;
          const recovery =
            state === "finished"
              ? ""
              : `\n\nSession ${session.sessionId} is saved and can be resumed with subagent spawn(sessionId: "${session.sessionId}", prompt: "...").`;
          const header = `${getSubagentHeading(reason || (failed ? "failed" : undefined), timedOut, stopped)}: ${label}`;
          const mainContent = truncated.content
            ? `\n\n${truncated.content}`
            : "";
          const reasonText = reason ? `\n\nReason: ${reason}` : "";
          if (!job.stoppedManually) {
            manager.deliverCompletion(
              `${header}${mainContent}${truncationNote}${reasonText}${recovery}${fallback}${badge}`,
              completion,
              expectedGeneration,
            );
          }
        } finally {
          clearTimeout(timer);
          unsubscribe();
          manager.jobs.delete(pid);
          await disposeChild();
          manager.syncStatus(ctx);
        }
      })();
      job.done = manager.track(done);

      const location = branch ? `\nBranch: ${branch}` : "";
      const queueMsg =
        completion === "queue"
          ? " Output queued for next turn."
          : " The result will arrive automatically.";
      return {
        content: [
          {
            type: "text",
            text: `${existing ? "Continued" : "Created"} subagent "${label}" [${displayModel}:${session.thinkingLevel}] • Session: ${session.sessionId}.${queueMsg}${location}${fallback}`,
          },
        ],
        details: {
          pid,
          sessionId: session.sessionId,
          sessionFile,
          model: displayModel,
          thinking: session.thinkingLevel,
          cwd: childCwd,
          inheritedTools: actualTools,
          context: record.context,
          state: record.state,
          continued: Boolean(existing),
          ...(branch ? { branch } : {}),
          ...(modelFallbackMessage
            ? { modelFallback: modelFallbackMessage }
            : {}),
        },
      };
    },
    renderCall(args, theme, _context) {
      const action = args.action ?? "spawn";
      if (action === "status")
        return new Text(
          theme.fg(
            "toolTitle",
            theme.bold(
              `Subagent status${args.sessionId ? `: ${args.sessionId}` : ""}`,
            ),
          ),
          0,
          0,
        );
      if (action === "stop")
        return new Text(
          theme.fg(
            "toolTitle",
            theme.bold(`Stop subagent ${args.sessionId ?? ""}`),
          ),
          0,
          0,
        );
      if (action === "steer")
        return new Text(
          theme.fg(
            "toolTitle",
            theme.bold(
              `Steer subagent ${args.sessionId ?? ""}: ${args.message ?? ""}`,
            ),
          ),
          0,
          0,
        );

      const label = args.description || args.prompt || "...";
      const modelTag = args.model
        ? ` [${args.model}${args.thinking ? `:${args.thinking}` : ""}]`
        : "";
      const completionTag = args.completion === "queue" ? " [queue]" : "";
      return new Text(
        `${theme.fg("toolTitle", theme.bold(`Subagent: ${label}`))}${theme.fg("dim", modelTag + completionTag)}`,
        0,
        0,
      );
    },
    renderResult(result, options, theme, context) {
      return renderToolResult(result, options, theme, 10);
    },
  });
}
