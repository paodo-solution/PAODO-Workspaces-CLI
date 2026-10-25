import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { run } from "../src/main.mjs";
import { CONTRACT_VERSION } from "../src/http.mjs";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

for (const flag of ["--version", "-v"]) {
  test(`${flag} prints the npm release and the contract, with no app call`, async (t) => {
    const fetch = t.mock.method(globalThis, "fetch", async () => assert.fail("--version must not reach the app"));
    const log = t.mock.method(console, "log", () => {});
    await run([flag]);
    assert.equal(fetch.mock.callCount(), 0);
    assert.equal(log.mock.calls[0].arguments[0], `npm version : ${version}\ncontract version : ${CONTRACT_VERSION}`);
  });
}
