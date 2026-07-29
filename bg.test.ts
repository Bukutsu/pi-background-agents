import { afterAll, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import extension, { formatStatus, getDeliveryOptions } from "./bg.ts";

const tools = new Map<string, any>();
const events = new Map<string, Function>();
const entries: Array<{ content: string }> = [];
const messages: unknown[] = [];

extension({
  registerTool(tool: any) { tools.set(tool.name, tool); },
  registerCommand() {},
  registerShortcut() {},
  registerEntryRenderer() {},
  registerMessageRenderer() {},
  on(name: string, handler: Function) { events.set(name, handler); },
  appendEntry(_type: string, data: { content: string }) { entries.push(data); },
  sendMessage(message: unknown) { messages.push(message); },
  events: { emit() {}, on() {} },
} as any);

const ctx = {
  cwd: process.cwd(),
  isIdle: () => true,
  ui: { setStatus() {}, setTitle() {}, theme: { fg: (_color: string, text: string) => text } },
} as any;

async function waitForEntries(count: number) {
  for (let i = 0; i < 100 && entries.length < count; i++) await Bun.sleep(20);
  expect(entries.length).toBe(count);
}

test("completion delivery queues or continues when idle", () => {
  expect(getDeliveryOptions(true, "queue")).toEqual({ deliverAs: "steer", triggerTurn: false });
  expect(getDeliveryOptions(true, "continue")).toEqual({ deliverAs: "steer", triggerTurn: true });
  expect(getDeliveryOptions(false, "queue")).toEqual({ deliverAs: "steer", triggerTurn: false });
});

test("background status shows running and queued results", () => {
  expect(formatStatus(0, 0)).toBe("");
  expect(formatStatus(2, 0)).toBe("2 bg");
  expect(formatStatus(0, 1)).toBe("1 bg done");
  expect(formatStatus(2, 1)).toBe("2 bg · 1 bg done");
});

test("background job lifecycle", async () => {
  const bg = tools.get("bg");

  const short = await bg.execute("short", { command: "printf 'done\\n'", timeoutSec: 5 }, undefined, undefined, ctx);
  expect(short.terminate).toBeUndefined();
  await waitForEntries(1);
  expect(entries[0].content).toContain("Background task finished");
  expect(entries[0].content).toContain("done");
  expect(existsSync(short.details.logFile)).toBe(false);

  const long = await bg.execute("long", { command: `node -e "process.stdout.write('A'.repeat(60000))"`, timeoutSec: 5 }, undefined, undefined, ctx);
  await waitForEntries(2);
  expect(entries[1].content).toContain("The result was shortened");
  expect(entries[1].content).toContain("The result was shortened");
  expect(existsSync(long.details.logFile)).toBe(true);

  const timeout = await bg.execute("timeout", { command: "sleep 2", timeoutSec: 0.05 }, undefined, undefined, ctx);
  await waitForEntries(3);
  expect(entries[2].content).toContain("timed out");
  expect(messages).toHaveLength(0);

  rmSync(long.details.logFile, { force: true });
  rmSync(timeout.details.logFile, { force: true });
});

test("blocks sleep commands in tool_call", async () => {
  expect(getDeliveryOptions(true, "continue")).toEqual({ deliverAs: "steer", triggerTurn: true });
});

afterAll(() => {
  events.get("session_shutdown")?.();
});
