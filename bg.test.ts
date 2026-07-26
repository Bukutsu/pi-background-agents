import { afterAll, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import extension, { formatStatus, getDeliveryOptions, getSubagentSession } from "./bg.ts";

const tools = new Map<string, any>();
const events = new Map<string, Function>();
const entries: Array<{ content: string }> = [];
const messages: unknown[] = [];

extension({
  registerTool(tool: any) { tools.set(tool.name, tool); },
  registerCommand() {},
  registerEntryRenderer() {},
  registerMessageRenderer() {},
  on(name: string, handler: Function) { events.set(name, handler); },
  appendEntry(_type: string, data: { content: string }) { entries.push(data); },
  sendMessage(message: unknown) { messages.push(message); },
} as any);

const ctx = {
  cwd: process.cwd(),
  isIdle: () => true,
  ui: { setStatus() {}, theme: { fg: (_color: string, text: string) => text } },
} as any;

async function waitForEntries(count: number) {
  for (let i = 0; i < 100 && entries.length < count; i++) await Bun.sleep(20);
  expect(entries.length).toBe(count);
}

test("completion delivery queues or continues when idle", () => {
  expect(getDeliveryOptions(true, "queue")).toEqual({ deliverAs: "nextTurn", triggerTurn: false });
  expect(getDeliveryOptions(true, "continue")).toEqual({ deliverAs: "steer", triggerTurn: true });
  expect(getDeliveryOptions(false, "queue")).toEqual({ deliverAs: "steer", triggerTurn: false });
});

test("background status shows running and queued results", () => {
  expect(formatStatus(0, 0)).toBe("");
  expect(formatStatus(2, 0)).toBe("2 bg");
  expect(formatStatus(0, 1)).toBe("1 bg done");
  expect(formatStatus(2, 1)).toBe("2 bg · 1 bg done");
});

test("subagent sessions are generated or reused", () => {
  const fresh = getSubagentSession();
  expect(fresh.id).toMatch(/^[0-9a-f-]{36}$/);
  expect(fresh.args).toEqual(["--no-session", "--session-id", fresh.id]);
  expect(fresh.args).toContain("--no-session");
  expect(fresh.args).not.toContain("--session-dir");

  const whitespace = getSubagentSession("   ");
  expect(whitespace.args).toContain("--no-session");
  expect(whitespace.args).not.toContain("--session-dir");

  const existing = "123e4567-e89b-42d3-a456-426614174000";
  const custom = getSubagentSession(` ${existing} `);
  expect(custom).toEqual({
    id: existing,
    args: ["--session-id", existing, "--session-dir", expect.stringMatching(/pi-bg[/\\]sessions$/)],
  });
  expect(custom.args).toContain("--session-dir");
  expect(custom.args).not.toContain("--no-session");
  expect(custom.args[custom.args.indexOf("--session-dir") + 1]).toMatch(/pi-bg[/\\]sessions$/);
});

test("background job lifecycle", async () => {
  const bg = tools.get("bg");

  const short = await bg.execute("short", { command: "printf 'done\\n'", timeoutSec: 5 }, undefined, undefined, ctx);
  expect(short.terminate).toBeUndefined();
  await waitForEntries(1);
  expect(entries[0].content).toContain("Background task finished");
  expect(entries[0].content).toContain("done");
  expect(existsSync(short.details.logFile)).toBe(false);

  const long = await bg.execute("long", { command: `node -e "process.stdout.write('A'.repeat(2501))"`, timeoutSec: 5 }, undefined, undefined, ctx);
  await waitForEntries(2);
  expect(entries[1].content).toContain("[Middle omitted]");
  expect(entries[1].content).toContain("The result was shortened");
  expect(existsSync(long.details.logFile)).toBe(true);

  const timeout = await bg.execute("timeout", { command: "sleep 2", timeoutSec: 0.05 }, undefined, undefined, ctx);
  await waitForEntries(3);
  expect(entries[2].content).toContain("timed out");
  expect(messages).toHaveLength(0);

  rmSync(long.details.logFile, { force: true });
  rmSync(timeout.details.logFile, { force: true });
});

afterAll(() => {
  events.get("session_shutdown")?.();
});
