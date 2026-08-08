import assert from "node:assert/strict";
import test from "node:test";
import { registerWaitBlocker } from "../src/manager.js";
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

test("blocks sleep and polling loops in bash tool calls", async () => {
  const handlers: Array<{ name: string; handler: (event: any) => any }> = [];
  const pi: any = {
    on(name: string, handler: (event: any) => any) {
      handlers.push({ name, handler });
    },
  };
  registerWaitBlocker(pi);
  const toolCall = handlers.find((h) => h.name === "tool_call");
  assert.ok(toolCall);
  const run = (event: any) => toolCall.handler(event);

  // Legitimate calls are not blocked.
  assert.equal(
    await run({ toolName: "bash", input: { command: "ls -la" } }),
    undefined,
  );
  assert.equal(
    await run({ toolName: "bash", input: { command: "rg -n sleep src" } }),
    undefined,
  );
  assert.equal(
    await run({ toolName: "bash", input: { command: "timeout 30 npm test" } }),
    undefined,
  );
  assert.equal(
    await run({
      toolName: "bash",
      input: {
        command: "for f in src/*.ts; do wc -l $f; done",
      },
    }),
    undefined,
  );
  assert.equal(
    await run({ toolName: "read", input: { path: "src/manager.ts" } }),
    undefined,
  );

  // Waiting calls are blocked, including chained and looped forms.
  for (const command of [
    "sleep 5",
    "sleep 0.1 && subagent status",
    "git pull && sleep 30",
    "watch -n 2 ls",
    "while true; do sleep 1; done",
    "until curl -s localhost:8080; do sleep 5; done",
    "for i in {1..10}; do sleep 1; done",
    "n=0; while [ $n -lt 5 ]; do sleep 1; done",
  ]) {
    const result = await run({ toolName: "bash", input: { command } });
    assert.equal(result?.block, true, `expected ${command} to be blocked`);
    assert.match(result.reason, /results arrive automatically/);
  }
});

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
});

test("validates bg and subagent tool parameters", async () => {
  const { tools } = setup();
  const bg = tools.find((t) => t.name === "bg");
  const subagent = tools.find((t) => t.name === "subagent");
  const ctx: any = {
    cwd: process.cwd(),
    hasUI: false,
    isIdle: () => true,
    sessionManager: {
      getSessionId: () => "smoke-session",
      getSessionFile: () => undefined,
    },
  };

  await assert.rejects(
    () =>
      bg.execute(
        "id",
        { action: "spawn", command: "" },
        undefined,
        undefined,
        ctx,
      ),
    /command is required for spawn/,
  );

  await assert.rejects(
    () =>
      bg.execute(
        "id",
        { action: "stop", pid: 9999 },
        undefined,
        undefined,
        ctx,
      ),
    /Shell job not found/,
  );

  await assert.rejects(
    () =>
      subagent.execute(
        "id",
        { action: "spawn", prompt: "" },
        undefined,
        undefined,
        ctx,
      ),
    /prompt is required for spawn/,
  );

  await assert.rejects(
    () =>
      subagent.execute(
        "id",
        { action: "spawn", prompt: "test", cwd: "./src", worktree: true },
        undefined,
        undefined,
        ctx,
      ),
    /cwd cannot be combined with worktree:true/,
  );

  await assert.rejects(
    () =>
      subagent.execute(
        "id",
        { action: "stop", sessionId: "missing" },
        undefined,
        undefined,
        ctx,
      ),
    /Running subagent not found/,
  );
});
