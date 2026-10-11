import { test } from "node:test";
import assert from "node:assert/strict";
import create from "../src/commands/connection/create.mjs";
import { issue } from "../src/commands/workspace/key/channel.mjs";
import { channels, limit } from "../src/contract.mjs";

process.env.PAODO_ENDPOINT = "https://example.invalid";
process.env.PAODO_TOKEN = "test-only-no-network";

const CONTRACT = { channels: { api: "api-key", sse: "sse-config" }, limits: { listingEntries: 7 } };

/** A fetch that serves the contract and records everything else, answering it with `reply`. */
function stub(t, reply = {}) {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const path = url.replace("https://example.invalid", "");
    calls.push(`${options.method} ${path}`);
    return Response.json(path === "/api/contract" ? CONTRACT : reply);
  });
  return calls;
}

test("the contract is read once however many parts are asked for", async (t) => {
  const calls = stub(t);
  assert.equal(await limit("listingEntries"), 7);
  assert.deepEqual(Object.keys(await channels()), ["api", "sse"]);
  assert.deepEqual(calls, ["GET /api/contract"]);
});

test("a channel the app published is usable, and a refusal lists the app's channels", async (t) => {
  const calls = stub(t, { workspaceSseHasKey: true });
  t.mock.method(console, "log", () => {});
  await issue("generate", ["ws-1", "sse"]);
  assert.equal(calls.at(-1), "POST /api/workspaces/ws-1/sse-config");
  await assert.rejects(issue("generate", ["ws-1", "mcp"]), { code: "CLI_USAGE_ERROR", message: /"api" or "sse"/ });
});

test("connection create sends the pair as given and prints the roles the app answered with", async (t) => {
  const calls = stub(t, { kind: "call", id: "call_1", caller: { id: "a", name: "Sales" }, callee: { id: "b", name: "Billing" } });
  const printed = [];
  t.mock.method(console, "log", (text) => printed.push(text));
  await create.run(["a", "b"]);
  assert.equal(calls.at(-1), "POST /api/connections");
  assert.match(printed.join("\n"), /connectionId : "call_1"[\s\S]*caller : "Sales"\ncallerId : "a"\ncallee : "Billing"\ncalleeId : "b"/);
});
