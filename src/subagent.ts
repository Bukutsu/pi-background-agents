import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, sep } from "node:path";
import {
  createAgentSession,
  ModelRuntime,
  resolveCliModel,
  SessionManager,
  SettingsManager,
  truncateTail,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  type AssistantMessage,
  type Model,
  StringEnum,
  type ThinkingLevel,
} from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { JobManager } from "./manager.js";
import {
  getLogDir,
  SUBAGENT_INDEX,
  SUBAGENT_SESSION_DIR,
  SUBAGENT_WORKTREES,
  type BgJob,
  type SubagentRecord,
  type TerminalState,
} from "./types.js";
import {
  acquireSessionLock,
  ensurePrivateDir,
  extractTextContent,
  getScopedModels,
  getSubagentHeading,
  readIndex,
  renderToolResult,
  resolveSubagentCwd,
  sanitizeForkMessages,
  saveRecord,
} from "./utils.js";
import { createWorktree, removeWorktree } from "./worktree.js";

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
      const icon =
        s.state === "running" ? "●" : s.state === "finished" ? "✓" : "✖";
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
      "For independent tasks that don't depend on each other, spawn multiple subagents in one turn; each runs in the background and its result arrives as it finishes.",
      "For sequential work that builds on prior results, spawn one subagent, then spawn the next with the previous result in its prompt.",
      "Use worktree:true for concurrent writing subagents; pi-background-agents creates but never merges or removes the branch/worktree.",
      "After starting a subagent, continue work immediately; never wait, sleep, or poll action:status for completion. Results arrive automatically.",
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
          description:
            "Message queued after the running child's current turn (steer only)",
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
        completion,
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
      const findActiveSubagent = (id: string) => {
        const matches = Array.from(manager.jobs.values()).filter(
          (job) =>
            job.kind === "subagent" &&
            (job.sessionId === id || job.sessionId?.startsWith(id)),
        );
        if (matches.length > 1)
          throw new Error(
            `Ambiguous subagent session prefix '${id}' matches ${matches.length} running sessions; use the full sessionId`,
          );
        return matches[0];
      };
      const findDurableRecord = (id: string) => {
        if (durable[id]) return durable[id];
        const matches = Object.values(durable).filter((r) =>
          r.sessionId.startsWith(id),
        );
        if (matches.length > 1)
          throw new Error(
            `Ambiguous subagent session prefix '${id}' matches ${matches.length} sessions; use the full sessionId`,
          );
        return matches[0];
      };

      const matching = requestedId
        ? findActiveSubagent(requestedId)
        : undefined;

      // ── setupChildSession: child-session setup for spawn ──
      // Model resolution, tool allowlist, session creation, and extension
      // binding. Divergent orchestration (locks, worktrees, fork/resume,
      // durable records) stays in the callers.
      type ChildSetupOptions = {
        cwd: string;
        model?: string;
        thinking?: ThinkingLevel;
        tools?: string;
        sessionManager: SessionManager;
        existing?: boolean; // resume: keep saved model/thinking unless overridden
        checkSetup?: () => void; // spawn: guard against parent session end
        shutdownHandler?: () => void; // caller controller to abort on ctx.shutdown()
      };
      const setupChildSession = async (opts: ChildSetupOptions) => {
        const { existing = false, checkSetup, shutdownHandler } = opts;
        modelRuntime ??= ModelRuntime.create();
        const runtime = await modelRuntime;
        checkSetup?.();
        for (const providerId of ctx.modelRegistry.getRegisteredProviderIds()) {
          try {
            const native =
              ctx.modelRegistry.getRegisteredNativeProvider(providerId);
            const config =
              ctx.modelRegistry.getRegisteredProviderConfig(providerId);
            if (native) {
              runtime.registerNativeProvider(native);
            } else if (config) {
              runtime.registerProvider(providerId, config);
            } else {
              const provider = ctx.modelRegistry.getProvider(providerId);
              if (provider) {
                runtime.registerNativeProvider(provider);
              }
            }
          } catch (providerError) {
            console.warn(
              `Could not forward provider ${providerId} to subagent runtime:`,
              providerError,
            );
          }
        }
        const modelSpec = opts.model?.trim();
        let resolvedModel: Model<any> | undefined;
        let resolvedThinking: ThinkingLevel | undefined;
        const scopedList = getScopedModels(ctx);
        if (modelSpec) {
          if (scopedList && scopedList.length > 0) {
            const lowerSpec = modelSpec.toLowerCase();
            const exact = scopedList.find(
              (s) =>
                `${s.model.provider}/${s.model.id}`.toLowerCase() ===
                  lowerSpec || s.model.id.toLowerCase() === lowerSpec,
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
              resolvedThinking = (opts.thinking ??
                matched.thinkingLevel) as ThinkingLevel | undefined;
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
              cliThinking: opts.thinking,
              modelRuntime: runtime,
            });
            if (resolved.error) throw new Error(resolved.error);
            if (resolved.warning) console.warn(resolved.warning);
            resolvedModel = resolved.model;
            resolvedThinking = (opts.thinking ??
              resolved.thinkingLevel) as ThinkingLevel | undefined;
          }
        }
        const parentTools = pi
          .getActiveTools()
          .filter((name) => name !== "bg" && name !== "subagent");
        const requestedTools = opts.tools
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
        mkdirSync(SUBAGENT_SESSION_DIR, { recursive: true });
        ensurePrivateDir(SUBAGENT_SESSION_DIR);
        const requestedThinking = opts.thinking ?? resolvedThinking;
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
        checkSetup?.();
        const setupController = new AbortController();
        let created: Awaited<ReturnType<typeof createAgentSession>> | undefined;
        try {
          created = await createAgentSession({
            cwd: opts.cwd,
            tools: childTools,
            excludeTools: ["bg", "subagent"],
            modelRuntime: runtime,
            sessionManager: opts.sessionManager,
            settingsManager: SettingsManager.create(opts.cwd, undefined, {
              // Children only load project resources when the parent already
              // trusted this checkout; never by default.
              projectTrusted: ctx.isProjectTrusted(),
            }),
            ...(selectedModel ? { model: selectedModel } : {}),
            ...(!existing
              ? { thinkingLevel: effectiveThinking as ThinkingLevel }
              : requestedThinking
                ? { thinkingLevel: requestedThinking as ThinkingLevel }
                : {}),
          });
          checkSetup?.();
        } catch (error) {
          if (created) {
            try {
              await created.session.dispose();
            } catch {}
          }
          throw error;
        }
        const session = created.session;
        let disposed = false;
        const dispose = async () => {
          if (disposed) return;
          disposed = true;
          try {
            await session.extensionRunner.emit({
              type: "session_shutdown",
              reason: "quit",
            });
          } catch {}
          try {
            await session.dispose();
          } catch {}
        };
        try {
          checkSetup?.();
          await session.bindExtensions({
            mode: "print",
            abortHandler: () => void session.abort(),
            shutdownHandler: () => {
              setupController.abort();
              shutdownHandler?.();
            },
            onError: (error) =>
              console.warn(`Subagent extension error: ${error.error}`),
          });
          checkSetup?.();
          if (setupController.signal.aborted)
            throw new Error(
              "Subagent extension requested shutdown during setup",
            );
          for (const error of created.extensionsResult.errors)
            console.warn(
              `Subagent extension failed to load ${error.path}: ${error.error}`,
            );
        } catch (error) {
          await dispose();
          throw error;
        }
        if (!session.model) {
          await dispose();
          throw new Error("Subagent session did not initialize a model");
        }
        const actualTools = session.getActiveToolNames();
        const missingTools =
          requestedTools?.filter((name) => !actualTools.includes(name)) ?? [];
        if (missingTools.length) {
          await dispose();
          throw new Error(
            `Requested tools were not available in the child: ${missingTools.join(", ")}`,
          );
        }
        return {
          session,
          modelFallbackMessage: created.modelFallbackMessage,
          actualTools,
          dispose,
        };
      };

      if (action === "status") {
        const active = new Map(
          Array.from(manager.jobs.values())
            .filter((job) => job.kind === "subagent" && job.record)
            .map((job) => [job.sessionId!, job]),
        );
        const durableRecord = requestedId
          ? findDurableRecord(requestedId)
          : undefined;
        const records = requestedId
          ? matching?.record
            ? [matching.record]
            : durableRecord
              ? [durableRecord]
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
        if (completion !== undefined) matching.completion = completion;
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
      if (existing) {
        // Only resume from paths this extension controls: the session file
        // must be a regular file inside the pi-bg session dir, and the cwd
        // inside the parent project or a pi-bg worktree. A tampered index
        // must not redirect the child elsewhere.
        let sessionFileReal = "";
        try {
          sessionFileReal = realpathSync(existing.sessionFile);
        } catch {}
        const sessionDirReal = realpathSync(SUBAGENT_SESSION_DIR);
        if (
          !sessionFileReal.startsWith(sessionDirReal + sep) ||
          !statSync(sessionFileReal).isFile()
        ) {
          throw new Error(
            `Cannot resume subagent ${requestedId}: session file is not a regular file inside ${SUBAGENT_SESSION_DIR}: ${existing.sessionFile}`,
          );
        }
        if (existing.branch) {
          let cwdReal = "";
          try {
            cwdReal = realpathSync(existing.cwd);
          } catch {}
          const worktreesReal = realpathSync(SUBAGENT_WORKTREES);
          if (!cwdReal.startsWith(worktreesReal + sep)) {
            throw new Error(
              `Cannot resume subagent ${requestedId}: worktree cwd is outside ${SUBAGENT_WORKTREES}: ${existing.cwd}`,
            );
          }
        } else if (resolveSubagentCwd(ctx.cwd, existing.cwd) !== existing.cwd) {
          throw new Error(
            `Cannot resume subagent ${requestedId}: saved cwd is outside the parent project: ${existing.cwd}`,
          );
        }
      }

      let branch: string | undefined;
      let childCwd: string;
      let isNewWorktree = false;
      if (existing) {
        childCwd = existing.cwd;
        if (cwd) {
          const resolvedCwd = resolveSubagentCwd(ctx.cwd, cwd);
          if (resolvedCwd !== childCwd) {
            throw new Error(
              `cwd does not match the saved subagent cwd: ${childCwd}`,
            );
          }
        }
        branch = existing.branch;
      } else if (worktree) {
        const created = await createWorktree(pi, ctx, setupSignal);
        childCwd = created.path;
        branch = created.branch;
        isNewWorktree = true;
        checkSetup();
      } else {
        childCwd = resolveSubagentCwd(ctx.cwd, cwd);
      }

      let session: Awaited<ReturnType<typeof createAgentSession>>["session"];
      let modelFallbackMessage: string | undefined;
      let sessionFile: string;
      let sessionLock: string;
      let controller = new AbortController();
      let actualTools: string[];
      let disposeChild: () => Promise<void> = async () => {};

      try {
        checkSetup();
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
            sessionManager.appendMessage(parentMessage as any);
        const targetSessionId =
          existing?.sessionId ?? sessionManager.getSessionId();
        try {
          sessionLock = acquireSessionLock(targetSessionId);
        } catch (lockError) {
          // Clean up orphaned session file if we created one before lock acquisition
          if (!existing) {
            try {
              rmSync(sessionManager.getSessionFile() ?? "", { force: true });
            } catch {}
          }
          throw lockError;
        }
        let prepared: Awaited<ReturnType<typeof setupChildSession>>;
        try {
          prepared = await setupChildSession({
            cwd: childCwd,
            model,
            thinking: thinking as ThinkingLevel | undefined,
            tools,
            sessionManager,
            existing: Boolean(existing),
            checkSetup,
            shutdownHandler: () => controller.abort(),
          });
        } catch (error) {
          // setupChildSession disposes anything it created; free the lock and
          // any fresh session file here
          try {
            rmSync(sessionLock, { recursive: true, force: true });
          } catch {}
          if (!existing) {
            try {
              rmSync(sessionManager.getSessionFile() ?? "", { force: true });
            } catch {}
          }
          throw error;
        }
        session = prepared.session;
        modelFallbackMessage = prepared.modelFallbackMessage;
        actualTools = prepared.actualTools;
        disposeChild = async () => {
          await prepared.dispose();
          try {
            rmSync(sessionLock, { recursive: true, force: true });
          } catch {}
        };
        // Fresh sessions that fail after setup would leave an unindexed
        // session file; remove it so nothing orphaned accumulates.
        const cleanupNewSession = async () => {
          await disposeChild();
          if (!existing) {
            try {
              rmSync(sessionManager.getSessionFile() ?? "", { force: true });
            } catch {}
          }
        };
        if (!session.model) {
          await cleanupNewSession();
          throw new Error("Subagent session did not initialize a model");
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
          await cleanupNewSession();
          throw error;
        }
        sessionFile =
          session.sessionFile ?? sessionManager.getSessionFile() ?? "";
        if (!sessionFile) {
          await cleanupNewSession();
          throw new Error(
            "Subagent session did not initialize a persistent session path",
          );
        }
      } catch (setupError) {
        if (isNewWorktree) {
          await removeWorktree(pi, ctx.cwd, childCwd, branch);
        }
        throw setupError;
      }

      const pid = manager.nextVirtualPid++;
      let timedOut = false;
      let cancelled = false;
      let lastAssistantMessage: AssistantMessage | undefined;
      const activeTools = new Map<string, string>();
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
        activeTools,
      };
      try {
        manager.jobs.set(pid, job);
        saveRecord(record);
      } catch (error) {
        manager.jobs.delete(pid);
        await disposeChild();
        if (isNewWorktree) {
          await removeWorktree(pi, ctx.cwd, childCwd, branch);
        }
        throw error;
      }

      const setActivity = (activity: string) => {
        if (job.activity === activity) return;
        job.activity = activity;
        manager.syncStatus(ctx);
      };
      const unsubscribe = session.subscribe((event) => {
        if (
          (event.type === "message_update" || event.type === "message_end") &&
          event.message.role === "assistant"
        ) {
          lastAssistantMessage = event.message;
        }
        if (event.type === "turn_start") setActivity("thinking");
        else if (
          event.type === "message_update" &&
          event.assistantMessageEvent?.type === "text_delta" &&
          !activeTools.size
        )
          setActivity("responding");
        else if (event.type === "tool_execution_start") {
          activeTools.set(event.toolCallId, event.toolName);
          setActivity(`tool: ${[...activeTools.values()].join(", ")}`);
        } else if (event.type === "tool_execution_end") {
          activeTools.delete(event.toolCallId);
          if (event.isError) job.toolFailures!++;
          setActivity(
            activeTools.size
              ? `tool: ${[...activeTools.values()].join(", ")}`
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
          const assistant = lastAssistantMessage;
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
          const rawText = extractTextContent(assistant?.content).trim();
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
              job.completion ?? "continue",
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
    renderResult(result, options, theme, _context) {
      return renderToolResult(result, options, theme, 10);
    },
  });
}
