import assert from "node:assert/strict";
import test from "node:test";
import {
  isSubagentRecord,
  sanitizeTerminalOutput,
  usageSince,
} from "../src/utils.js";
import type { SubagentRecord } from "../src/types.js";

const record: SubagentRecord = {
  sessionId: "session-1",
  cwd: process.cwd(),
  sessionFile: "/tmp/session.jsonl",
  model: "provider/model",
  label: "test",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  state: "finished",
  turns: 1,
  toolCount: 2,
  toolFailures: 0,
  usage: {
    input: 1,
    output: 2,
    cacheRead: 3,
    cacheWrite: 4,
    total: 10,
    cost: 0.01,
  },
  inheritedTools: ["read"],
  context: "project",
};

test("accepts complete records and rejects incomplete durable records", () => {
  assert.equal(isSubagentRecord(record), true);
  assert.equal(isSubagentRecord({ ...record, usage: undefined }), false);
  assert.equal(isSubagentRecord({ ...record, context: undefined }), false);
  assert.equal(isSubagentRecord({ ...record, turns: undefined }), false);
});

test("handles absent usage fields and strips terminal control sequences", () => {
  assert.deepEqual(
    usageSince(
      { tokens: { input: 4, total: 4 }, cost: 0.3 } as any,
      { tokens: { input: 1, total: 1 }, cost: 0.1 } as any,
    ),
    {
      input: 3,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 3,
      cost: 0.19999999999999998,
    },
  );
  assert.equal(sanitizeTerminalOutput("ok\x1b[31m unsafe\x1b[0m"), "ok unsafe");
});
