import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.mjs";

const BIN = fileURLToPath(new URL("../bin/paodo.mjs", import.meta.url));

/** Runs `loadConfig` with these two variables, restoring whatever was set before. */
function configWith(t, endpoint, token = "test-only-no-network") {
  const previous = { endpoint: process.env.PAODO_ENDPOINT, token: process.env.PAODO_TOKEN };
  process.env.PAODO_ENDPOINT = endpoint;
  process.env.PAODO_TOKEN = token;
  t.after(() => {
    for (const [name, value] of [["PAODO_ENDPOINT", previous.endpoint], ["PAODO_TOKEN", previous.token]]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  return loadConfig();
}

/** The CLI as a user runs it, with a config directory of its own and nothing inherited from this shell. */
function runCli(t, { file, env = {} }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "paodo-config-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, "paodo"));
  fs.writeFileSync(path.join(home, "paodo", ".env"), file);
  const { PAODO_ENDPOINT: _endpoint, PAODO_TOKEN: _token, ...inherited } = process.env;
  return spawnSync(process.execPath, [BIN, "app", "status"], {
    env: { ...inherited, XDG_CONFIG_HOME: home, ...env },
    encoding: "utf8",
  });
}

test("plain http to a remote host is refused, so the token never crosses the network in the clear", (t) => {
  assert.throws(() => configWith(t, "http://example.invalid"), { code: "CLI_CONFIG_ERROR", message: /must use https/ });
});

test("plain http to this machine is accepted, as is https anywhere", (t) => {
  for (const endpoint of ["http://localhost:3000", "http://127.0.0.1:3000", "http://[::1]:3000", "https://example.invalid"]) {
    assert.equal(configWith(t, endpoint).endpoint, endpoint);
  }
});

test("the config file is read from $XDG_CONFIG_HOME/paodo/.env", (t) => {
  // A remote http endpoint fails in config, before any request, so the refusal proves the file was read.
  const result = runCli(t, { file: "PAODO_ENDPOINT=http://example.invalid\nPAODO_TOKEN=x\n" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /must use https/);
});

test("an exported variable wins over the config file", (t) => {
  const result = runCli(t, {
    file: "PAODO_ENDPOINT=https://example.invalid\nPAODO_TOKEN=x\n",
    env: { PAODO_ENDPOINT: "http://example.invalid" },
  });
  assert.match(result.stderr, /must use https/);
});
