import { test } from "node:test";
import assert from "node:assert/strict";
import set from "../src/commands/workspace/schedule/set.mjs";

test("schedule set sends one PATCH with only named fields", async (t) => {
  const previousEndpoint = process.env.PAODO_ENDPOINT;
  const previousToken = process.env.PAODO_TOKEN;
  process.env.PAODO_ENDPOINT = "https://example.invalid";
  process.env.PAODO_TOKEN = "test-only-no-network";
  t.after(() => {
    if (previousEndpoint === undefined) delete process.env.PAODO_ENDPOINT;
    else process.env.PAODO_ENDPOINT = previousEndpoint;
    if (previousToken === undefined) delete process.env.PAODO_TOKEN;
    else process.env.PAODO_TOKEN = previousToken;
  });
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url, method: options.method, ...(options.body ? { body: JSON.parse(options.body) } : {}) });
    if (url.endsWith("/api/contract")) return Response.json({ fields: { schedule: { intervalValue: { type: "int" } } } });
    return Response.json({ enabled: false, intervalValue: 5, nextRunAt: null });
  });
  await set.run(["workspace-id", "intervalValue=5"]);
  // The contract read is what makes 5 a number: the field's type is the app's, not a list kept here.
  assert.deepEqual(calls, [
    { url: "https://example.invalid/api/contract", method: "GET" },
    {
      url: "https://example.invalid/api/workspaces/workspace-id/schedule",
      method: "PATCH", body: { intervalValue: 5 },
    },
  ]);
});
