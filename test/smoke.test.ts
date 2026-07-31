import assert from "node:assert/strict";
import test from "node:test";
import { registerBgModule } from "../src/bg.js";
import { registerSubagentModule } from "../src/subagent.js";

function setup() {
  const tools: any[] = [];
  const commands: any[] = [];
  const pi: any = {
    registerTool: (tool: any) => tools.push(tool),
    registerCommand: (name: string, command: any) =>
      commands.push({ name, command }),
    registerMessageRenderer() {},
    getActiveTools: () => ["read", "bash", "bg", "subagent"],
  };
  const manager: any = {
    jobs: new Map(),
    generation: 0,
    lifecycle: new AbortController(),
    nextVirtualPid: 1,
    currentCtx: undefined,
    shuttingDown: false,
    guard() {},
    syncStatus() {},
    track: (promise: Promise<void>) => promise,
    deliverCompletion() {},
    killJob: () => false,
  };
  registerBgModule(pi, manager);
  registerSubagentModule(pi, manager);
  return { tools, commands };
}

test("registers bg and subagent status tools", async () => {
  const { tools, commands } = setup();
  const bg = tools.find((tool) => tool.name === "bg");
  const subagent = tools.find((tool) => tool.name === "subagent");
  assert.ok(bg);
  assert.ok(subagent);
  assert.ok(commands.some((command) => command.name === "bg"));

  const ctx: any = {
    cwd: process.cwd(),
    hasUI: false,
    isIdle: () => true,
    sessionManager: {
      getSessionId: () => "smoke-session",
      getSessionFile: () => undefined,
    },
  };
  const bgStatus = await bg.execute(
    "smoke",
    { action: "status" },
    undefined,
    undefined,
    ctx,
  );
  assert.deepEqual(bgStatus.details.jobs, []);

  const subagentStatus = await subagent.execute(
    "smoke",
    { action: "status", sessionId: "smoke-missing-session" },
    undefined,
    undefined,
    ctx,
  );
  assert.match(subagentStatus.content[0].text, /No matching subagent sessions/);
});
