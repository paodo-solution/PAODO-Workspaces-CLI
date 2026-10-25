import { test } from "node:test";
import assert from "node:assert/strict";
import create from "../src/commands/connection/create.mjs";
import ls from "../src/commands/connection/ls.mjs";
import { issue } from "../src/commands/workspace/key/channel.mjs";
import { channels, describeFields, limit } from "../src/contract.mjs";
import { format } from "../src/output.mjs";

process.env.PAODO_ENDPOINT = "https://example.invalid";
process.env.PAODO_TOKEN = "test-only-no-network";

const CONTRACT = {
  channels: { api: "api-key", sse: "sse-config" },
  limits: { listingEntries: 7 },
  fields: {
    workspace: {
      name: { type: "string", rule: "1-100 characters" },
      intervalUnit: { type: "string", values: ["minute", "hour"] },
      internetAccess: {
        type: "boolean",
        effect: "While false, the container reaches no host. While true, it reaches every host unless domainRestriction is true.",
      },
    },
  },
};

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

test("set --help lays each field out as kubectl explain does: name and type, then its text wrapped beneath", async (t) => {
  stub(t);
  const text = format({ fields: await describeFields("workspace")() });
  assert.equal(
    text,
    [
      "fields :",
      "",
      "  name  <string>",
      "    1-100 characters.",
      "",
      "  intervalUnit  <minute|hour>",
      "",
      "  internetAccess  <boolean>",
      "    While false, the container reaches no host. While true, it reaches every",
      "    host unless domainRestriction is true.",
    ].join("\n"),
  );
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

test("connection ls relays the app's whole listing from one request, each end as a name and an id", async (t) => {
  const calls = stub(t, {
    driveLinks: [{ id: "link_1", drive: { id: "d", name: null }, workspace: { id: "a", name: "Sales" } }],
    agentCalls: [],
  });
  const printed = [];
  t.mock.method(console, "log", (text) => printed.push(text));
  await ls.run([]);
  assert.deepEqual(calls, ["GET /api/connections"]);
  assert.match(printed.join("\n"), /id : "link_1"\ndrive : \(not found\)\ndriveId : "d"\nworkspace : "Sales"\nworkspaceId : "a"/);
  assert.match(printed.join("\n"), /agentCalls : \(none\)/);
});

test("connection ls names the id it was given and puts the subject the app answered with on the envelope", async (t) => {
  const calls = stub(t, {
    workspace: { id: "a b", name: "Sales" },
    drives: [],
    callers: [],
    callees: [{ id: "call_1", callee: { id: "b", name: "Billing" } }],
  });
  const printed = [];
  t.mock.method(console, "log", (text) => printed.push(text));
  await ls.run(["a b"]);
  assert.deepEqual(calls, ["GET /api/connections?for=a%20b"]);
  assert.match(printed.join("\n"), /^ok : true\nworkspaceId : "a b"\nworkspace : "Sales"\ndrives : \(none\)\ncallers : \(none\)\n\ncallees :/);
  assert.match(printed.join("\n"), /id : "call_1"\ncallee : "Billing"\ncalleeId : "b"/);
});

test("connection ls refuses a reply holding no group, and an empty id before any request", async (t) => {
  const calls = stub(t, { nope: true });
  await assert.rejects(ls.run([]), { code: "INVALID_RESPONSE" });
  await assert.rejects(ls.run([""]), { code: "CLI_USAGE_ERROR" });
  assert.deepEqual(calls, ["GET /api/connections"]);
});
