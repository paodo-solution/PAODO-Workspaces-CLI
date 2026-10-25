import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import tar from "tar-stream";
import { receiveLocalTransfer } from "../src/file-transfer.mjs";

/** A tar archive holding these entries, as the app's transfer route would answer with it. */
async function archive(entries) {
  const pack = tar.pack();
  for (const { name, type = "file", body = "", linkname } of entries) {
    pack.entry({ name, type, ...(linkname ? { linkname } : {}) }, type === "file" ? body : undefined);
  }
  pack.finalize();
  const chunks = [];
  for await (const chunk of pack) chunks.push(chunk);
  return new Response(Buffer.concat(chunks), { headers: { "content-type": "application/x-tar" } });
}

/** An empty directory to pull into, removed after the test. */
function workdir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paodo-pull-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("a well-formed archive lands at the destination", async (t) => {
  const dir = workdir(t);
  const response = await archive([
    { name: "payload", type: "directory" },
    { name: "payload/a.txt", body: "hello" },
  ]);
  const receipt = await receiveLocalTransfer(response, path.join(dir, "out"));
  assert.equal(fs.readFileSync(path.join(dir, "out", "a.txt"), "utf8"), "hello");
  assert.deepEqual(receipt.created, [path.join(dir, "out")]);
});

// Each of these is an archive the CLI must refuse whole: nothing at the destination, and no staging
// directory left behind beside it.
const HOSTILE = {
  "an entry climbing out with ..": [{ name: "payload", type: "directory" }, { name: "payload/../evil.txt", body: "x" }],
  // Lands inside the payload once normalised, so only the canonical-name check catches it.
  "an entry with .. that stays inside": [{ name: "payload", type: "directory" }, { name: "payload/sub/../a.txt", body: "x" }],
  "an entry outside the payload root": [{ name: "payload", type: "directory" }, { name: "other/evil.txt", body: "x" }],
  "a symlink": [{ name: "payload", type: "directory" }, { name: "payload/link", type: "symlink", linkname: "/etc/passwd" }],
  "the same path twice": [{ name: "payload", type: "directory" }, { name: "payload/a.txt" }, { name: "payload/a.txt" }],
};

for (const [what, entries] of Object.entries(HOSTILE)) {
  test(`a pull refuses ${what} and writes nothing`, async (t) => {
    const dir = workdir(t);
    await assert.rejects(receiveLocalTransfer(await archive(entries), path.join(dir, "out")), { code: "INVALID_RESPONSE" });
    assert.deepEqual(fs.readdirSync(dir), []);
  });
}
