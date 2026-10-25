import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WORKSPACE, fileGroup } from "../src/commands/file/group.mjs";

const { ls, put, rm } = fileGroup(WORKSPACE).commands;

/** Points the client at a fake endpoint, answers every fetch with `body`, and records each URL. */
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
  const urls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    urls.push(new URL(url));
    // Drain an archive body, as a server would, so the pack that produces it can finish.
    if (options.body && typeof options.body[Symbol.asyncIterator] === "function") for await (const _ of options.body);
    return Response.json(body);
  });
  t.mock.method(console, "log", () => {});
  return urls;
}

// The app owns the path rules and refuses "/workspace/..." with the corrected path in its message. The
// CLI used to strip the leading slash first, which turned that path into a valid one to a new
// workspace/ directory — so each command here must send the path exactly as it was typed.

test("ls sends a path exactly as typed, leading slash included", async (t) => {
  const urls = stub(t, { tree: [] });
  await ls.run(["ws", "/workspace/src"]);
  assert.equal(urls[0].searchParams.get("path"), "/workspace/src");
});

test("rm sends a path exactly as typed, leading slash included", async (t) => {
  const urls = stub(t, { removed: [], removedCount: 0 });
  await rm.run(["ws", "/workspace/src/a.txt"]);
  assert.equal(urls[0].searchParams.get("path"), "/workspace/src/a.txt");
});

test("put sends its destination exactly as typed, leading slash included", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paodo-put-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, "a.txt");
  fs.writeFileSync(source, "hello");
  const urls = stub(t, { created: [], overwritten: [], ignored: [] });
  await put.run(["ws", source, "/workspace/a.txt"]);
  assert.equal(urls[0].searchParams.get("dest"), "/workspace/a.txt");
});
