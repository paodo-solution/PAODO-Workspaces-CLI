import { test } from "node:test";
import assert from "node:assert/strict";
import conversationLs from "../src/commands/workspace/conversation/ls.mjs";
import sessionLs from "../src/commands/workspace/conversation/session/ls.mjs";
import sessionShow from "../src/commands/workspace/conversation/session/show.mjs";
import callLs from "../src/commands/workspace/conversation/session/call/ls.mjs";
import callShow from "../src/commands/workspace/conversation/session/call/show.mjs";

/** Points the client at a fake endpoint, answers every fetch with `body`, and records each call. */
function stub(t, body) {
  const previous = { endpoint: process.env.PAODO_ENDPOINT, token: process.env.PAODO_TOKEN };
  process.env.PAODO_ENDPOINT = "https://example.invalid";
  process.env.PAODO_TOKEN = "test-only-no-network";
  t.after(() => {
    for (const [name, value] of [["PAODO_ENDPOINT", previous.endpoint], ["PAODO_TOKEN", previous.token]]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url, method: options.method ?? "GET" });
    return Response.json(body);
  });
  const printed = [];
  t.mock.method(console, "log", (line) => printed.push(line));
  return { calls, printed };
}

test("conversation ls reads the workspace's list and prints it", async (t) => {
  const { calls, printed } = stub(t, { conversations: [{ id: "c-1", title: "c-1", running: false }] });
  await conversationLs.run(["ws 1"]);
  assert.deepEqual(calls, [{ url: "https://example.invalid/api/workspaces/ws%201/conversations", method: "GET" }]);
  assert.match(printed.join("\n"), /workspaceId : "ws 1"/);
  assert.match(printed.join("\n"), /id : "c-1"/);
});

test("conversation ls refuses a body with no conversation list", async (t) => {
  stub(t, {});
  await assert.rejects(conversationLs.run(["ws-1"]), { code: "INVALID_RESPONSE" });
});

test("session ls encodes both ids and names them once in the envelope", async (t) => {
  const { calls, printed } = stub(t, { sessions: [{ sessionId: "s-1", origin: "chat" }] });
  await sessionLs.run(["ws-1", "conv/1"]);
  assert.deepEqual(calls, [
    { url: "https://example.invalid/api/workspaces/ws-1/conversations/conv%2F1/sessions", method: "GET" },
  ]);
  assert.match(printed.join("\n"), /conversationId : "conv\/1"/);
  assert.match(printed.join("\n"), /sessionId : "s-1"/);
});

test("session ls refuses an empty id before any request", async (t) => {
  const { calls } = stub(t, { sessions: [] });
  await assert.rejects(sessionLs.run(["ws-1", ""]), { code: "CLI_USAGE_ERROR" });
  await assert.rejects(sessionLs.run(["", "conv-1"]), { code: "CLI_USAGE_ERROR" });
  assert.deepEqual(calls, []);
});

test("session ls refuses a body with no session list", async (t) => {
  stub(t, { sessions: null });
  await assert.rejects(sessionLs.run(["ws-1", "conv-1"]), { code: "INVALID_RESPONSE" });
});

test("session show encodes all three ids and prints the session's texts", async (t) => {
  const { calls, printed } = stub(t, { session: { sessionId: "s/1", userInput: "fix it", agentResponse: "Done." } });
  await sessionShow.run(["ws-1", "conv/1", "s/1"]);
  assert.deepEqual(calls, [
    { url: "https://example.invalid/api/workspaces/ws-1/conversations/conv%2F1/sessions/s%2F1", method: "GET" },
  ]);
  assert.match(printed.join("\n"), /userInput : "fix it"/);
  assert.match(printed.join("\n"), /agentResponse : "Done."/);
});

test("session show refuses an empty session id before any request", async (t) => {
  const { calls } = stub(t, { session: {} });
  await assert.rejects(sessionShow.run(["ws-1", "conv-1", ""]), { code: "CLI_USAGE_ERROR" });
  assert.deepEqual(calls, []);
});

test("session show refuses a body with no session", async (t) => {
  stub(t, { sessions: [] });
  await assert.rejects(sessionShow.run(["ws-1", "conv-1", "s-1"]), { code: "INVALID_RESPONSE" });
});

test("session call ls encodes all three ids and prints each call's sizes", async (t) => {
  const { calls, printed } = stub(t, { calls: [{ callId: "k-1", tool: "file_read", inputChars: 15, outputChars: 300 }] });
  await callLs.run(["ws-1", "conv/1", "s/1"]);
  assert.deepEqual(calls, [
    { url: "https://example.invalid/api/workspaces/ws-1/conversations/conv%2F1/sessions/s%2F1/calls", method: "GET" },
  ]);
  assert.match(printed.join("\n"), /sessionId : "s\/1"/);
  assert.match(printed.join("\n"), /callId : "k-1"/);
  assert.match(printed.join("\n"), /outputChars : 300/);
});

test("session call ls prints a session with no calls rather than refusing it", async (t) => {
  const { printed } = stub(t, { calls: [] });
  await callLs.run(["ws-1", "conv-1", "s-1"]);
  assert.match(printed.join("\n"), /calls : \(none\)/);
});

test("session call ls refuses an empty session id and a body with no call list", async (t) => {
  const { calls } = stub(t, {});
  await assert.rejects(callLs.run(["ws-1", "conv-1", ""]), { code: "CLI_USAGE_ERROR" });
  assert.deepEqual(calls, []);
  await assert.rejects(callLs.run(["ws-1", "conv-1", "s-1"]), { code: "INVALID_RESPONSE" });
});

test("session call show encodes all four ids and prints the call's input and output", async (t) => {
  const { calls, printed } = stub(t, { call: { callId: "k/1", input: { path: "a.ts" }, output: "body" } });
  await callShow.run(["ws-1", "conv-1", "s-1", "k/1"]);
  assert.deepEqual(calls, [
    { url: "https://example.invalid/api/workspaces/ws-1/conversations/conv-1/sessions/s-1/calls/k%2F1", method: "GET" },
  ]);
  assert.match(printed.join("\n"), /input :\n\npath : "a.ts"/);
  assert.match(printed.join("\n"), /output : "body"/);
});

test("session call show refuses an empty call id and a body with no call", async (t) => {
  const { calls } = stub(t, { calls: [] });
  await assert.rejects(callShow.run(["ws-1", "conv-1", "s-1", ""]), { code: "CLI_USAGE_ERROR" });
  assert.deepEqual(calls, []);
  await assert.rejects(callShow.run(["ws-1", "conv-1", "s-1", "k-1"]), { code: "INVALID_RESPONSE" });
});
