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
  let killAllCalls = 0;
  let syncCalls = 0;
  const manager: any = {
    jobs: new Map(),
    generation: 0,
    lifecycle: new AbortController(),
    nextVirtualPid: 1,
    currentCtx: undefined,
    shuttingDown: false,
    guard() {},
    syncStatus() {
      syncCalls++;
    },
    track: (promise: Promise<void>) => promise,
    trackSetup: () => () => {},
    deliverCompletion() {},
    killJob: () => false,
    killAllJobs: () => {
      killAllCalls++;
      return 2;
    },
  };
  registerBgModule(pi, manager);
  registerSubagentModule(pi, manager);
  return {
    tools,
    commands,
    manager,
    getKillAllCalls: () => killAllCalls,
    getSyncCalls: () => syncCalls,
  };
}

test("registers bg and subagent status tools", async () => {
  const { tools, commands, manager, getKillAllCalls, getSyncCalls } = setup();
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

  let notification = "";
  const bgCommand = commands.find((command) => command.name === "bg");
  await bgCommand.command.handler("kill all", {
    ...ctx,
    ui: {
      notify: (message: string) => {
        notification = message;
      },
    },
  });
  assert.equal(getKillAllCalls(), 1);
  assert.equal(notification, "Stopped 2 background jobs");
  assert.equal(getSyncCalls(), 1);
  assert.equal(manager.killAllJobs instanceof Function, true);
});
