import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { buildSessionContext } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionStats,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Text } from "@earendil-works/pi-tui";
import {
  SUBAGENT_INDEX,
  SUBAGENT_LOCKS,
  type SubagentRecord,
} from "./types.js";

export function createMarkdownComponent(text: string, theme: Theme) {
  const mdTheme = {
    heading: (s: string) => theme.fg("toolTitle", theme.bold(s)),
    link: (s: string) => theme.fg("accent", s),
    linkUrl: (s: string) => theme.fg("dim", s),
    code: (s: string) => theme.fg("accent", s),
    codeBlock: (s: string) => theme.fg("toolOutput", s),
    codeBlockBorder: (s: string) => theme.fg("dim", s),
    quote: (s: string) => theme.fg("muted", s),
    quoteBorder: (s: string) => theme.fg("dim", s),
    hr: (s: string) => theme.fg("dim", s),
    listBullet: (s: string) => theme.fg("accent", s),
    bold: (s: string) => theme.bold(s),
    italic: (s: string) => s,
    strikethrough: (s: string) => s,
    underline: (s: string) => s,
  };
  return new Markdown(text, 0, 0, mdTheme);
}

export function renderToolResult(
  result: any,
  options: { expanded?: boolean },
  theme: Theme,
  previewLines: number,
) {
  const text =
    result.content
      ?.map((c: any) => (c.type === "text" ? c.text : ""))
      .filter(Boolean)
      .join("\n")
      .trim() || "";
  if (!text) return new Text("", 0, 0);
  if (options.expanded) return createMarkdownComponent(text, theme);
  const lines = text.split("\n");
  const preview = lines.slice(0, previewLines).join("\n");
  const hidden = lines.length - previewLines;
  const hint =
    hidden > 0 ? `\n${theme.fg("dim", `... (${hidden} more lines)`)}` : "";
  return createMarkdownComponent(preview + hint, theme);
}

export const STATE_ICONS: Record<string, string> = {
  running: "●",
  finished: "✓",
  failed: "✖",
  "timed-out": "✖",
  interrupted: "✖",
  stopped: "✖",
};

export function readIndex(): Record<string, SubagentRecord> {
  const records: Record<string, SubagentRecord> = {};
  if (!existsSync(SUBAGENT_INDEX)) return records;
  for (const entry of readdirSync(SUBAGENT_INDEX, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    try {
      const record = JSON.parse(
        readFileSync(join(SUBAGENT_INDEX, entry.name), "utf8"),
      ) as SubagentRecord;
      if (
        !record ||
        typeof record.sessionId !== "string" ||
        !/^[a-zA-Z0-9-]+$/.test(record.sessionId)
      )
        throw new Error("invalid sessionId");
      records[record.sessionId] = record;
    } catch (error) {
      console.warn(`Ignoring invalid subagent record ${entry.name}:`, error);
    }
  }
  return records;
}

export function saveRecord(record: SubagentRecord) {
  if (!/^[a-zA-Z0-9-]+$/.test(record.sessionId))
    throw new Error(`Invalid subagent session ID: ${record.sessionId}`);
  mkdirSync(SUBAGENT_INDEX, { recursive: true, mode: 0o700 });
  const target = join(SUBAGENT_INDEX, `${record.sessionId}.json`);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, {
    mode: 0o600,
    flush: true,
  });
  renameSync(temporary, target);
}

export function usageSince(current: SessionStats, baseline: SessionStats) {
  return {
    input: current.tokens.input - baseline.tokens.input,
    output: current.tokens.output - baseline.tokens.output,
    cacheRead: current.tokens.cacheRead - baseline.tokens.cacheRead,
    cacheWrite: current.tokens.cacheWrite - baseline.tokens.cacheWrite,
    total: current.tokens.total - baseline.tokens.total,
    cost: current.cost - baseline.cost,
  };
}

export function sanitizeForkMessages(ctx: ExtensionContext) {
  const messages = buildSessionContext(ctx.sessionManager.getBranch()).messages;
  const resultIds = new Set(
    messages.flatMap((message) =>
      message.role === "toolResult" &&
      !["bg", "subagent"].includes(message.toolName)
        ? [message.toolCallId]
        : [],
    ),
  );
  const callIds = new Set<string>();
  const sanitized: any[] = [];
  for (const message of messages) {
    if (message.role === "custom" && message.customType === "pi-bg-result")
      continue;
    if (
      message.role === "compactionSummary" ||
      message.role === "branchSummary"
    ) {
      sanitized.push({
        role: "user",
        content: `Parent conversation summary:\n${message.summary}`,
        timestamp: message.timestamp,
      });
      continue;
    }
    if (message.role === "assistant") {
      if (typeof message.content === "string") {
        sanitized.push(message);
        continue;
      }
      if (!Array.isArray(message.content)) continue;
      const content = message.content.filter((part) => {
        if (part.type !== "toolCall") return true;
        if (["bg", "subagent"].includes(part.name) || !resultIds.has(part.id))
          return false;
        callIds.add(part.id);
        return true;
      });
      if (content.length)
        sanitized.push({
          ...message,
          content,
          usage: {
            ...message.usage,
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            cacheWrite1h: 0,
            reasoning: 0,
            totalTokens: 0,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
        });
      continue;
    }
    if (message.role === "toolResult") {
      if (callIds.has(message.toolCallId))
        sanitized.push({ ...message, usage: undefined });
      continue;
    }
    sanitized.push(message);
  }
  return sanitized;
}

export function processIsAlive(pid?: number) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function acquireSessionLock(sessionId: string) {
  if (!/^[a-zA-Z0-9-]+$/.test(sessionId))
    throw new Error(`Invalid subagent session ID: ${sessionId}`);
  mkdirSync(SUBAGENT_LOCKS, { recursive: true, mode: 0o700 });
  const lock = join(SUBAGENT_LOCKS, sessionId);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const tmp = `${lock}.tmp-${randomUUID()}`;
      try {
        mkdirSync(tmp, { mode: 0o700 });
        writeFileSync(join(tmp, "owner"), String(process.pid), {
          mode: 0o600,
        });
        renameSync(tmp, lock);
      } catch (createError) {
        try {
          rmSync(tmp, { recursive: true, force: true });
        } catch {}
        throw createError;
      }
      return lock;
    } catch (error: any) {
      if (error?.code !== "EEXIST" && error?.code !== "ENOTEMPTY") throw error;
      try {
        const ownerFile = join(lock, "owner");
        const owner = existsSync(ownerFile)
          ? Number(readFileSync(ownerFile, "utf8"))
          : NaN;
        if (!Number.isNaN(owner) && processIsAlive(owner))
          throw new Error(
            `Subagent session ${sessionId} is already running in process ${owner}`,
          );
        const stale = `${lock}.stale-${randomUUID()}`;
        renameSync(lock, stale);
        rmSync(stale, { recursive: true, force: true });
      } catch (staleError: any) {
        if (staleError?.code === "ENOENT") {
          continue;
        } else if (staleError?.message?.includes("already running")) {
          throw staleError;
        }
      }
    }
  }
  throw new Error(`Could not acquire subagent session lock: ${sessionId}`);
}

export function getSubagentHeading(
  error?: string,
  timedOut = false,
  cancelled = false,
) {
  return timedOut
    ? "Background subagent timed out"
    : cancelled
      ? "Background subagent was stopped"
      : error
        ? "Background subagent failed"
        : "Background subagent finished";
}

// ponytail: scopedModels only exists on pi >=0.83.0; guard so older hosts fall through to resolveCliModel
export function getScopedModels(ctx: ExtensionContext) {
  return "scopedModels" in ctx
    ? (ctx as { scopedModels?: Array<{ model: any; thinkingLevel?: any }> })
        .scopedModels
    : undefined;
}

// ponytail: let the user plug in model providers from installed npm packages
// (e.g. "antigravity") that the host itself doesn't have configured. Sourced
// from the PI_BG_PROVIDERS env var and an optional ./pi-bg.config.json.
export async function loadCustomProviders(pi: ExtensionAPI) {
  const specifiers = new Set<string>();
  const env = process.env.PI_BG_PROVIDERS?.split(/[,\s]+/).filter(Boolean);
  if (env) for (const spec of env) specifiers.add(spec);
  try {
    const cfgPath = join(process.cwd(), "pi-bg.config.json");
    if (existsSync(cfgPath)) {
      const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
      if (Array.isArray(cfg?.providers))
        for (const p of cfg.providers)
          if (typeof p === "string") specifiers.add(p);
    }
  } catch (error) {
    console.warn("Could not read pi-bg provider config:", error);
  }
  const VALID_SPECIFIER = /^[a-z0-9@][a-z0-9@/_.-]*$/i;
  for (const spec of specifiers) {
    if (!VALID_SPECIFIER.test(spec) || spec.includes("..")) {
      console.warn(
        `Ignoring invalid custom provider package specifier "${spec}"`,
      );
      continue;
    }
    try {
      const mod = await import(spec);
      const candidates = Array.isArray(mod) ? mod : [mod.default ?? mod];
      for (const candidate of candidates) {
        if (!candidate || typeof candidate !== "object") continue;
        if (
          typeof candidate.id === "string" &&
          (candidate.stream || candidate.complete)
        ) {
          pi.registerProvider(candidate);
        } else {
          pi.registerProvider(candidate.name ?? spec, candidate);
        }
      }
    } catch (error) {
      console.warn(`Could not load custom provider package "${spec}":`, error);
    }
  }
}

export function resolveSubagentCwd(parent: string, requested?: string) {
  const root = realpathSync(parent);
  const requestedPath = resolve(root, requested?.trim() || ".");
  if (!existsSync(requestedPath))
    throw new Error(`cwd does not exist: ${requestedPath}`);
  const target = realpathSync(requestedPath);
  const rel = relative(root, target);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(
      `cwd must be inside the parent project; use worktree:true for isolated external work: ${target}`,
    );
  }
  if (!statSync(target).isDirectory())
    throw new Error(`cwd is not a directory: ${target}`);
  return target;
}
