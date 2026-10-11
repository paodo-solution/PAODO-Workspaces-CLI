#!/usr/bin/env node
// PAODO CLI regression suite: every command in the tree, run in sequence.
//
//   node tests/run.mjs --dry-run   # print exactly what would run, touch nothing
//   node tests/run.mjs             # run everything, write tests/report.json
//   node tests/run.mjs --keep      # keep the local scratch dir for inspection
//   node tests/run.mjs --only=files,keys      # selected groups (prerequisites pulled in automatically)
//   node tests/run.mjs --offline   # only the groups that never touch the app (help, dispatch, config, transport)
//   node tests/run.mjs --sweep     # also delete self-test workspaces and drives a crashed earlier run left behind
//
// What this is for: one command that says whether anything in the CLI surface broke. So it covers both
// halves of every command — the call that should work and the call that should be refused. A CLI whose
// refusals stopped refusing is broken in the way that matters most here, because a caller gets an `ok`
// receipt for something that did not happen (see the note in cli/src/args.mjs).
//
// ---------------------------------------------------------------------------------------------------
// The groups, and which of them the app ever hears from:
//
//   help       — the help tree. No request, except the three `set --help` leaves, which ask the app for
//                their fields and print the rest without them when it does not answer.
//   dispatch   — unknown commands, wrong arity, undeclared options, local guards. No request: every one
//                of these is refused before a connection is opened.
//   config     — cli/src/config.mjs, driven by overriding PAODO_ENDPOINT/PAODO_TOKEN in the child's
//                environment (exported variables beat the .env beside the CLI, which is what makes this
//                testable). Points at invalid or unroutable hosts. No request reaches the app.
//   transport  — cli/src/http.mjs's failure taxonomy and cli/src/file-transfer.mjs's archive guards,
//                driven by a stub HTTP server this process runs on 127.0.0.1. These are the answers a
//                real app is not supposed to give, so they cannot be provoked against a healthy one.
//                No request reaches the app.
//   app        — reads against the real app that need nothing of ours: its health, its models, the two
//                registries, and the connection graph.
//   workspace  — the workspaces this suite owns: create, every settable field, the app's rejections.
//   files      — a workspace's five file verbs: both path spaces, both directions, windowing, and what
//                a transfer refuses to carry.
//   drive      — the drives this suite owns: create with and without a description, both settable
//                fields, and the name-uniqueness rule that belongs to the app alone.
//   drivefiles — the same five verbs over a drive, plus the two things that are only true here: a new
//                drive is empty where a new workspace is not, and neither space can see the other's
//                files or answer to the other's ids.
//   connection — both graphs: a drive link, an agent call, what each says when made twice, and the
//                pairs that are refused.
//   keys       — the three key verbs on both channels, in the order that makes each refusal observable.
//   teardown   — the deletes, and proof each id is gone.
//
// The file group is written once in the CLI and mounted under both nouns (cli/src/commands/file/
// group.mjs), so `files` and `drivefiles` are deliberately not mirror images. `files` carries the long
// half — every path spelling, every window, every refusal — because that is the one implementation both
// nouns run. `drivefiles` carries what mounting it a second time could break and nothing else: that the
// drive's routes are the drive's, that the receipts say `drive`, and that the two spaces stay apart.
//
// What this does to the server, in full, because a suite that provisions containers has to say so:
//
//   * It creates exactly TWO workspaces and TWO drives, all four named paodo-cli-selftest…, and deletes
//     every one of them at the end — including on a crash, and including when a case fails partway
//     through. Every write lands inside them.
//   * The second workspace and the second drive exist for one refusal each that cannot be provoked with
//     one of a kind: an agent call needs two workspaces, and "two drives cannot be connected" needs two
//     drives. Both are otherwise idle.
//   * It creates connections between the things it owns, and removes them itself. Deleting a workspace
//     or a drive takes its connections with it, so the teardown is a second net under them.
//   * Pre-existing workspaces and drives are only ever READ (`workspace ls`, `drive ls`,
//     `connection ls`). Nothing else addresses an id it did not create, except two fixed all-zero and
//     all-one UUIDs used to check 404 handling, and one fabricated `link_` id used to check that
//     removing a connection that is not there is an answer rather than a failure.
//   * `--sweep` is the one exception, and it is off by default: without it, leftover self-test
//     workspaces and drives are reported, not deleted.
//   * Requests are strictly serial — one child process, one request at a time, never a fan-out.
//   * Roughly half the suite sends nothing to the app at all (see the group list above).
//   * Nothing invokes a workspace agent, so no LLM inference is triggered and no tokens are spent. The
//     CLI has no command that can. `connection create` between two workspaces grants the caller the
//     delegation tools; it does not use them.
//   * A preflight `app status` runs first. If the app is not answering, every case that needs it is
//     skipped rather than attempted, and the offline groups still run.
//   * A circuit breaker aborts the remaining app-facing cases after a few consecutive infrastructure
//     failures (timeout, 5xx, 429, refused connection). Teardown is exempt, because a workspace or a
//     drive that exists still has to be deleted.
//
// Secrets: key receipts carry plaintext secrets exactly once. Nothing that looks like one is written to
// report.json — see redact(), which is deliberately broader than the field names alone.

import { execFile, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const ENTRY = path.join(REPO, "cli", "bin", "paodo.mjs");
const TMP = path.join(HERE, ".scratch");
const REPORT = path.join(HERE, "report.json");

const flags = process.argv.slice(2);
const DRY_RUN = flags.includes("--dry-run");
const KEEP = flags.includes("--keep");
const SWEEP = flags.includes("--sweep");
const OFFLINE = flags.includes("--offline");

// Names no human resource would carry, so a sweep can recognise its own leftovers. The spaced variants
// are ones the suite sets on purpose, to prove a quoted multi-word value survives the trip.
const WS_NAME = "paodo-cli-selftest";
const WS2_NAME = "paodo-cli-selftest-callee";
const WS_SPACED = "paodo cli selftest";
const DRIVE_NAME = "paodo-cli-selftest-drive";
const DRIVE2_NAME = "paodo-cli-selftest-drive-2";
const DRIVE_SPACED = "paodo cli selftest drive";
const DRIVE_DESCRIPTION = "Second drive, for the two-drives refusal.";

const SELFTEST_WORKSPACES = new Set([WS_NAME, `${WS_NAME}-renamed`, WS_SPACED, WS2_NAME]);
const SELFTEST_DRIVES = new Set([DRIVE_NAME, `${DRIVE_NAME}-renamed`, DRIVE_SPACED, DRIVE2_NAME]);

const MISSING_ID = "00000000-0000-0000-0000-000000000000";
// A second id nothing answers to, for the refusals that need two ids that differ: `connection create`
// checks that both ids name something before it checks anything else about them, and the same id twice
// is refused earlier, by a different guard.
const MISSING_ID_2 = "11111111-1111-1111-1111-111111111111";
// Well-formed enough for `connection rm` to route it, and connected to nothing.
const MISSING_LINK_ID = `link_${MISSING_ID}`;

const WS_PLACEHOLDER = "<workspace-id>";
const DRIVE_PLACEHOLDER = "<drive-id>";
const STUB_PLACEHOLDER = "http://127.0.0.1:<stub-port>";

/**
 * Everything this run creates, in the order teardown removes it, and what removing it is spelled as.
 *
 * One list rather than four blocks, because it is read three times — by the teardown cases, by the
 * forced cleanup that runs when the suite did not reach them, and by the report — and a resource
 * present in two of those three is exactly how one gets left running.
 */
const OWNED = [
  { key: "ws", removedKey: "removedWs", noun: "workspace", name: WS_NAME },
  { key: "ws2", removedKey: "removedWs2", noun: "workspace", name: WS2_NAME },
  { key: "drive", removedKey: "removedDrive", noun: "drive", name: DRIVE_NAME },
  { key: "drive2", removedKey: "removedDrive2", noun: "drive", name: DRIVE2_NAME },
];

// Groups that reach the real app. Everything else is refused locally or answered by the stub on
// 127.0.0.1, so it neither needs the app nor is skipped when the app is down.
const APP_FACING = new Set([
  "app",
  "workspace",
  "files",
  "drive",
  "drivefiles",
  "connection",
  "keys",
  "teardown",
  "preflight",
  "sweep",
]);
const OFFLINE_GROUPS = new Set(["help", "dispatch", "config", "transport"]);

/** Codes that mean the app or the path to it failed, not that the command under test was refused. */
const INFRA_CODES = [
  "NETWORK_ERROR",
  "NETWORK_TIMEOUT",
  "NETWORK_CONNECTION_REFUSED",
  "NETWORK_DNS_ERROR",
  "NETWORK_TLS_ERROR",
  "CLI_HTTP_INTERNAL_ERROR",
  "CLI_HTTP_SERVICE_UNAVAILABLE",
  "CLI_HTTP_RATE_LIMITED",
  "CLI_HTTP_UNAUTHORIZED",
  "CLI_HTTP_FORBIDDEN",
  "CLI_CONFIG_ERROR",
  "INVALID_RESPONSE",
];
const BREAKER_LIMIT = 4;

// ---------------------------------------------------------------------------- config, for the report

/** The endpoint the CLI will use, and the token to keep out of the report — read as bin/paodo.mjs does. */
function readCliEnv() {
  const out = { endpoint: process.env.PAODO_ENDPOINT ?? null, token: process.env.PAODO_TOKEN ?? null };
  try {
    for (const line of fs.readFileSync(path.join(REPO, "cli", ".env"), "utf8").split("\n")) {
      const match = /^\s*(PAODO_ENDPOINT|PAODO_TOKEN)\s*=\s*(.*?)\s*$/.exec(line);
      if (!match) continue;
      const value = match[2].replace(/^["']|["']$/g, "");
      if (match[1] === "PAODO_ENDPOINT") out.endpoint ??= value;
      else out.token ??= value;
    }
  } catch {
    // No .env beside the CLI is a valid setup: exported variables work too.
  }
  return out;
}

const ENV = readCliEnv();

/** `paodo` as installed if the link works, otherwise this repo's entry point run directly. */
function resolveBinary() {
  const probe = spawnSync("paodo", ["--help"], { encoding: "utf8", timeout: 20_000 });
  if (!probe.error && probe.status === 0) return { how: "PATH (npm link)", file: "paodo", prefix: [] };
  return { how: "repo entry (paodo not on PATH)", file: process.execPath, prefix: [ENTRY] };
}

const BIN = resolveBinary();

// ---------------------------------------------------------------------------- output handling

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A workspace name, a model id, an endpoint segment: dash-joined lowercase words, which no secret is.
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)+$/;
// A connection id. It carries an underscore, so the opaque-run pass below would take it for a secret —
// and it is the one field `connection rm` accepts, which makes it the last thing to hide from a report.
const CONNECTION_ID = /^(?:link|call)_[A-Za-z0-9_-]+$/;

/**
 * A key receipt's plaintext, gone before it reaches disk.
 *
 * Three passes, because one is not enough for a file that lands in the repo. The field-name pass is the
 * obvious one and catches `workspaceApiKey`. The URL pass catches a secret carried as a query parameter
 * of a connection string, where the field is called `url` and the name pass sees nothing. The last pass
 * is the backstop for a field this suite has never seen: any long opaque run of token characters. UUIDs,
 * dash-joined lowercase slugs and connection ids are exempt, because `workspaceId` and `driveId` are the
 * first, workspace names and model ids are the second, and `connectionId` is the third — those are the
 * things the report exists to show.
 *
 * Booleans and numbers survive the name pass, and so does an empty value: `workspaceApiHasKey : true`
 * is the field the keys group actually asserts on, and a bare `key :` is output.mjs's header line for
 * the nested block below it — there is no secret in a value that is not there, and redacting one turned
 * `paodo workspace key --help` in the report into a page about a censored subject.
 *
 * Assertions run against the raw output, never this, so an over-eager redaction costs readability and
 * never a verdict.
 */
function redact(text) {
  let out = text.replace(
    /^([ \t]*)([A-Za-z0-9_.-]*(?:key|secret|token|password|credential)[A-Za-z0-9_.-]*)([ \t]*:[ \t]*)(.*)$/gim,
    (line, indent, name, sep, value) =>
      /^(true|false|\(none\)|\d+)?$/i.test(value.trim()) ? line : `${indent}${name}${sep}«redacted»`,
  );
  out = out.replace(/([?&](?:[A-Za-z0-9_.-]*(?:key|secret|token|auth)[A-Za-z0-9_.-]*)=)[^&\s]+/gi, "$1«redacted»");
  out = out.replace(/[A-Za-z0-9_-]{32,}/g, (candidate) =>
    UUID.test(candidate) || SLUG.test(candidate) || CONNECTION_ID.test(candidate) ? candidate : "«redacted»",
  );
  if (ENV.token) out = out.split(ENV.token).join("«redacted»");
  return out;
}

const MAX_OUTPUT = 4000;

function clip(text) {
  const trimmed = text.replace(/\s+$/, "");
  return trimmed.length <= MAX_OUTPUT
    ? { text: trimmed, truncated: false }
    : { text: `${trimmed.slice(0, MAX_OUTPUT)}\n…[${trimmed.length - MAX_OUTPUT} more characters]`, truncated: true };
}

function shellish(args) {
  return ["paodo", ...args.map((a) => (a === "" || /[\s"'*?$]/.test(a) ? JSON.stringify(a) : a))].join(" ");
}

function envSuffix(env) {
  return env ? ` [${Object.entries(env).map(([k, v]) => `${k}=${v === "" ? '""' : v}`).join(" ")}]` : "";
}

// ---------------------------------------------------------------------------- the scratch directory

function buildScratch() {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  const write = (rel, body, mode) => {
    const target = path.join(TMP, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body);
    if (mode !== undefined) fs.chmodSync(target, mode);
  };
  write("sample.txt", `${Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n")}\n`);
  write("tree/a.txt", "tree a\n");
  write("tree/nested/b.txt", "tree nested b\n");
  write("tree/nested/deep/c.txt", "tree nested deep c\n");
  // A leading dash is a path, not an option — the case `--` exists for.
  write("-dash.txt", "dashed name\n");
  // Not text, so a --offset/--limit window on it has to be refused rather than sliced.
  write("blob.bin", Buffer.from([0, 1, 2, 3, 255, 254, 0, 10, 13, 0]));
  // Nothing to count lines in, and nothing to pack a body for.
  write("empty.txt", "");
  // The executable branch of packLocalTransfer, which sets mode 0o755 on the archive entry.
  write("runme.sh", "#!/bin/sh\necho hi\n", 0o755);
  write("with space.txt", "spaced file name\n");
  // The app's own ignore contract is applied on arrival, not pre-filtered here, so this uploads and
  // comes back named in the receipt's `ignored` list.
  write("withmods/keep.txt", "keep me\n");
  write("withmods/node_modules/pkg/index.js", "module.exports = 1;\n");
  // collectLocalTransfer refuses a symlink rather than following it or packing it.
  fs.symlinkSync(path.join(TMP, "sample.txt"), path.join(TMP, "link.txt"));
}

// ---------------------------------------------------------------------------- the stub app
//
// The answers a healthy app never gives, so http.mjs's failure taxonomy and file-transfer.mjs's archive
// guards can be exercised without waiting for the real app to misbehave. The scenario is the first path
// segment of the endpoint the child is handed, so one server covers all of them and the CLI's own URL
// building is what selects one.

/** One 512-byte tar header plus its padded body. Hand-built so the stub needs no dependency. */
function tarEntry(name, content = "", type = "file") {
  const body = Buffer.from(content);
  const header = Buffer.alloc(512, 0);
  header.write(name, 0, 100, "utf8");
  header.write("0000755\0", 100, 8, "ascii"); // mode
  header.write("0000000\0", 108, 8, "ascii"); // uid
  header.write("0000000\0", 116, 8, "ascii"); // gid
  header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
  header.write("00000000000\0", 136, 12, "ascii"); // mtime
  header.write("        ", 148, 8, "ascii"); // checksum is computed over spaces, then written back
  header.write(type === "directory" ? "5" : "0", 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  const padded = Buffer.alloc(Math.ceil(body.length / 512) * 512, 0);
  body.copy(padded);
  return Buffer.concat([header, padded]);
}

const TAR_END = Buffer.alloc(1024, 0);

const STUB_SCENARIOS = {
  // A CLI cannot complete an interactive sign-in, so a redirect has to be refused rather than followed
  // into an HTML login page returned as a 200.
  redirect: (res) => res.writeHead(302, { Location: "/login" }).end(),
  html: (res) => res.writeHead(200, { "Content-Type": "text/html" }).end("<html>login</html>"),
  badjson: (res) => res.writeHead(200, { "Content-Type": "application/json" }).end("{oops"),
  // The app's own envelope, which the CLI must relay verbatim rather than paraphrase.
  apperror: (res) =>
    res
      .writeHead(400, { "Content-Type": "application/json" })
      .end(JSON.stringify({ ok: false, code: "STUB_APP_REFUSAL", error: "the app said no, in its own words", requestId: "rid-stub-1" })),
  // No JSON envelope to relay, so the code has to come from the status and the text has to survive.
  plainerror: (res) => res.writeHead(503, { "Content-Type": "text/plain" }).end("upstream is down"),
  // `/status/<n>` — one row of http.mjs's CODE_BY_STATUS per request, with no `body.code` to relay, so
  // the fallback spelling for that status is the only thing that can produce the answer.
  status: (res, segments) => res.writeHead(Number(segments[2]), { "Content-Type": "text/plain" }).end("no envelope here"),
  // A status with no entry in CODE_BY_STATUS, so the fallback spelling is what shows.
  teapot: (res) => res.writeHead(418, { "Content-Type": "application/json" }).end("{}"),
  // The three routes whose success shape cannot carry `ok` — `workspace ls`, `drive ls`, and the
  // listing `connection ls` relays — so each checks the shape itself.
  notarray: (res) => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ nope: true })),
  emptytar: (res) => res.writeHead(200, { "Content-Type": "application/x-tar" }).end(),
  outsidepayload: (res) =>
    res.writeHead(200, { "Content-Type": "application/x-tar" }).end(Buffer.concat([tarEntry("evil/x.txt", "nope\n"), TAR_END])),
  nopayloadroot: (res) =>
    res.writeHead(200, { "Content-Type": "application/x-tar" }).end(Buffer.concat([tarEntry("payload/x.txt", "no root\n"), TAR_END])),
  duplicate: (res) =>
    res.writeHead(200, { "Content-Type": "application/x-tar" }).end(
      Buffer.concat([
        tarEntry("payload", "", "directory"),
        tarEntry("payload/x.txt", "one\n"),
        tarEntry("payload/x.txt", "two\n"),
        TAR_END,
      ]),
    ),
  unsupportedentry: (res) =>
    res.writeHead(200, { "Content-Type": "application/x-tar" }).end(
      // Typeflag "2" is a symlink: a kind the extractor refuses rather than materialises.
      Buffer.concat([tarEntry("payload", "", "directory"), (() => {
        const entry = tarEntry("payload/link", "");
        entry.write("2", 156, 1, "ascii");
        // The checksum has to be recomputed, or the entry is rejected as corrupt instead of unsupported.
        entry.write("        ", 148, 8, "ascii");
        let sum = 0;
        for (let i = 0; i < 512; i++) sum += entry[i];
        entry.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
        return entry;
      })(), TAR_END]),
    ),
};

function startStub() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      // Drained unconditionally: a `file put` sends an archive, and a handler that answers without
      // reading it can leave the client waiting on a socket nobody is consuming.
      req.resume();
      const segments = new URL(req.url, "http://127.0.0.1").pathname.split("/");
      const handler = STUB_SCENARIOS[segments[1]];
      if (!handler) {
        res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: false, code: "STUB_NO_SCENARIO", error: `no stub scenario "${segments[1]}"` }));
        return;
      }
      handler(res, segments);
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

/** A port nothing is listening on, taken by binding and releasing it, so ECONNREFUSED is deterministic. */
function reserveClosedPort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

// ---------------------------------------------------------------------------- the case matrix
//
// Order is execution order: the lifecycle groups depend on the workspace or drive an earlier case
// created, and each key verb depends on the state the previous one left. `argv`, `env`, `match` and
// `notMatch` may each be a function of the captured context. `needs` names context keys that must
// exist, so a failed create skips its dependents instead of turning one failure into thirty.
//
// expect:
//   "receipt" — exit 0 and `ok : true`        (every command that goes through output.mjs's receipt)
//   "ok"      — exit 0 and no `ok : false`    (help, and `file cat`, which prints file bytes)
//   "error"   — exit 1 and `ok : false`       (a refusal, local or from the app)

// Every leaf in the tree, as `paodo --help` lists them. The five file verbs appear twice because they
// are mounted twice, and that is the point: one implementation, two nouns, and each mounting gets its
// own `--help` case below.
const LEAVES = [
  "app status",
  "app models",
  "workspace ls",
  "workspace get",
  "workspace create",
  "workspace set",
  "workspace rm",
  "workspace key generate",
  "workspace key rotate",
  "workspace key revoke",
  "workspace file ls",
  "workspace file cat",
  "workspace file get",
  "workspace file put",
  "workspace file rm",
  "drive ls",
  "drive get",
  "drive create",
  "drive set",
  "drive rm",
  "drive file ls",
  "drive file cat",
  "drive file get",
  "drive file put",
  "drive file rm",
  "connection ls",
  "connection create",
  "connection rm",
];

const TRANSFER_TIMEOUT = 90_000;
const CONFIG_ERROR = "CLI_CONFIG_ERROR";
const USAGE_ERROR = "CLI_USAGE_ERROR";

/** Endpoint pointed at one stub scenario. The CLI appends its own route to it. */
const stubEnv = (scenario) => (c) => ({ PAODO_ENDPOINT: `${c.stub}/${scenario}` });

const CASES = [
  // ---- help: one call has to surface every leaf, and every node has to answer for itself ----
  { group: "help", id: "help.root.none", argv: [], expect: "ok", match: ["paodo app status", "paodo workspace file put", "paodo drive file put", "paodo connection create", "vocabulary"] },
  { group: "help", id: "help.root.long", argv: ["--help"], expect: "ok", match: ["paodo workspace key generate"] },
  { group: "help", id: "help.root.short", argv: ["-h"], expect: "ok", match: ["paodo workspace key generate"] },
  { group: "help", id: "help.root.word", argv: ["help"], expect: "ok", match: ["paodo workspace key generate"] },
  // The vocabulary defines every noun the tree has. A noun added to one and not the other is a command
  // whose whole subject is undefined at the one place a caller reads for it — and `drive` and
  // `connection` each mean something specific enough that guessing from the command names is wrong:
  // that a drive is unversioned, and that an agent call goes one way.
  { group: "help", id: "help.root.nouns", argv: ["--help"], expect: "ok", match: ["drive :", "connection :", "local :", "not versioned", "one-way"] },
  { group: "help", id: "help.group.app", argv: ["app"], expect: "ok", match: ["paodo app status", "paodo app models"] },
  { group: "help", id: "help.group.app.flag", argv: ["app", "--help"], expect: "ok", match: ["paodo app models"] },
  { group: "help", id: "help.group.workspace", argv: ["workspace"], expect: "ok", match: ["paodo workspace set", "paodo workspace key revoke", "paodo workspace file put"] },
  { group: "help", id: "help.group.key", argv: ["workspace", "key"], expect: "ok", match: ["paodo workspace key rotate", "workspaceApiAccess"] },
  { group: "help", id: "help.group.workspace.file", argv: ["workspace", "file"], expect: "ok", match: ["paodo workspace file cat", "paodo workspace file put"] },
  { group: "help", id: "help.group.drive", argv: ["drive"], expect: "ok", match: ["paodo drive create", "paodo drive rm", "paodo drive file put"] },
  { group: "help", id: "help.group.drive.file", argv: ["drive", "file"], expect: "ok", match: ["paodo drive file cat", "paodo drive file put"] },
  { group: "help", id: "help.group.connection", argv: ["connection"], expect: "ok", match: ["paodo connection ls", "paodo connection create", "paodo connection rm"] },
  ...LEAVES.map((leaf) => ({
    group: "help",
    id: `help.leaf.${leaf.replaceAll(" ", "-")}`,
    argv: [...leaf.split(" "), "--help"],
    expect: "ok",
  })),
  // The three `set` entries print the app's own field list (GET /api/contract), so these are in `app`:
  // offline, the same help still prints with `fields : unavailable`, which the leaf cases above cover.
  { group: "app", id: "help.leaf.short-flag", argv: ["workspace", "set", "-h"], expect: "ok", match: ["maxIterations", "internetAccess"], notMatch: ["unavailable"] },
  { group: "app", id: "help.spec.workspace-set-fields", argv: ["workspace", "set", "--help"], expect: "ok", match: ["name", "description", "llmProvider", "llmModel", "reasoningEffort", "maxIterations", "maxRunMinutes", "internetAccess", "workspaceApiAccess", "workspaceMcpAccess"], notMatch: ["unavailable"] },
  { group: "app", id: "help.spec.drive-set-fields", argv: ["drive", "set", "--help"], expect: "ok", match: ["name", "description", "unique across drives", "no leading dot"], notMatch: ["unavailable"] },
  { group: "help", id: "help.spec.cat-options", argv: ["workspace", "file", "cat", "--help"], expect: "ok", match: ["offset", "limit"] },
  { group: "help", id: "help.spec.cat-options.drive", argv: ["drive", "file", "cat", "--help"], expect: "ok", match: ["offset", "limit"] },
  // The two mountings of the one file group. `fileHelp` substitutes the noun into every placeholder it
  // prints, so each of these has to be spelled in its own noun and neither may leak the other's: a
  // caller reading `drive file put --help` and finding `<workspace-id>` is reading the wrong contract,
  // and the one it names is the one whose writes are versioned.
  { group: "help", id: "help.file.noun.workspace", argv: ["workspace", "file", "put", "--help"], expect: "ok", match: ["workspace-dest", "this machine -> workspace", "history"], notMatch: ["drive-dest", "<drive-id>"] },
  { group: "help", id: "help.file.noun.drive", argv: ["drive", "file", "put", "--help"], expect: "ok", match: ["drive-dest", "this machine -> drive", "shared"], notMatch: ["workspace-dest", "<workspace-id>"] },
  { group: "help", id: "help.file.noun.drive.rm", argv: ["drive", "file", "rm", "--help"], expect: "ok", match: ["drive-path", "irreversible"], notMatch: ["workspace-path"] },
  // Two commands whose whole point is what they cost, and both say it in their own help rather than
  // leaving a caller to find out from the receipt.
  { group: "help", id: "help.drive.rm.says-irreversible", argv: ["drive", "rm", "--help"], expect: "ok", match: ["irreversible", "not versioned"] },
  { group: "help", id: "help.connection.rm.says-what-it-costs", argv: ["connection", "rm", "--help"], expect: "ok", match: ["link_", "call_", "deleted"] },
  // The counts and the listing are two answers to one question, and each help says where the other is.
  { group: "help", id: "help.workspace.get.points-at-connection-ls", argv: ["workspace", "get", "--help"], expect: "ok", match: ["connections", "paodo connection ls"] },
  { group: "help", id: "help.drive.get.points-at-connection-ls", argv: ["drive", "get", "--help"], expect: "ok", match: ["connections", "paodo connection ls"] },
  // Help wins over a bad argument list: `--help` is read before arity is checked, so asking how to
  // spell a command never requires already spelling it correctly. Checked at three levels deep too,
  // since that is where the file group now lives.
  { group: "help", id: "help.beats.arity", argv: ["workspace", "get", "--help"], expect: "ok", notMatch: ["Usage: paodo workspace get"] },
  { group: "help", id: "help.beats.arity.nested", argv: ["drive", "file", "get", "--help"], expect: "ok", notMatch: ["Usage: paodo drive file get"] },

  // ---- dispatch, arity and local guards: refusals that never open a connection ----
  { group: "dispatch", id: "bad.command.root", argv: ["bogus"], expect: "error", code: USAGE_ERROR, match: ['Unknown command "paodo bogus"'] },
  { group: "dispatch", id: "bad.command.workspace", argv: ["workspace", "bogus"], expect: "error", code: USAGE_ERROR },
  { group: "dispatch", id: "bad.command.key", argv: ["workspace", "key", "bogus"], expect: "error", code: USAGE_ERROR },
  { group: "dispatch", id: "bad.command.workspace.file", argv: ["workspace", "file", "bogus"], expect: "error", code: USAGE_ERROR, match: ['Unknown command "paodo workspace file bogus"'] },
  { group: "dispatch", id: "bad.command.drive", argv: ["drive", "bogus"], expect: "error", code: USAGE_ERROR },
  { group: "dispatch", id: "bad.command.drive.file", argv: ["drive", "file", "bogus"], expect: "error", code: USAGE_ERROR, match: ['Unknown command "paodo drive file bogus"'] },
  { group: "dispatch", id: "bad.command.connection", argv: ["connection", "bogus"], expect: "error", code: USAGE_ERROR },
  // The file verbs moved under the noun that owns the files. The old spelling has to fail loudly rather
  // than resolve to one of the two spaces, because an id alone cannot say which space it belongs to —
  // a `paodo file rm` that guessed would be deleting from whichever one it guessed.
  { group: "dispatch", id: "bad.command.bare-file", argv: ["file", "ls", MISSING_ID], expect: "error", code: USAGE_ERROR, match: ['Unknown command "paodo file"'] },
  { group: "dispatch", id: "bad.command.bare-file.rm", argv: ["file", "rm", MISSING_ID, "a.txt"], expect: "error", code: USAGE_ERROR, match: ['Unknown command "paodo file"'] },
  { group: "dispatch", id: "bad.option.root", argv: ["--bogus"], expect: "error", code: USAGE_ERROR, match: ['Unknown option "--bogus"'] },
  { group: "dispatch", id: "bad.option.dashdash-first", argv: ["--", "app", "status"], expect: "error", code: USAGE_ERROR },
  { group: "dispatch", id: "bad.option.leaf", argv: ["app", "status", "--force"], expect: "error", code: USAGE_ERROR, match: ['Unknown option "--force"'] },
  // The flags args.mjs exists to refuse: a dropped --dry-run would hand back an ok receipt for a
  // rehearsal that was really the operation. Checked on each of the three commands that destroy
  // something, since those are the ones a caller reaches for a safety flag on.
  { group: "dispatch", id: "bad.option.dry-run", argv: ["workspace", "rm", MISSING_ID, "--dry-run"], expect: "error", code: USAGE_ERROR },
  { group: "dispatch", id: "bad.option.force", argv: ["workspace", "file", "rm", MISSING_ID, "a.txt", "--force"], expect: "error", code: USAGE_ERROR },
  { group: "dispatch", id: "bad.option.drive-rm-force", argv: ["drive", "rm", MISSING_ID, "--force"], expect: "error", code: USAGE_ERROR, match: ['Unknown option "--force"'] },
  { group: "dispatch", id: "bad.option.drive-rm-yes", argv: ["drive", "rm", MISSING_ID, "--yes"], expect: "error", code: USAGE_ERROR },
  { group: "dispatch", id: "bad.option.connection-rm-force", argv: ["connection", "rm", MISSING_LINK_ID, "--force"], expect: "error", code: USAGE_ERROR },
  { group: "dispatch", id: "bad.option.short-alias", argv: ["workspace", "file", "cat", MISSING_ID, "sample.txt", "-o", "1"], expect: "error", code: USAGE_ERROR },
  // An option a different command does declare is still not this one's.
  { group: "dispatch", id: "bad.option.wrong-command", argv: ["workspace", "file", "ls", MISSING_ID, "--offset", "1"], expect: "error", code: USAGE_ERROR },
  { group: "dispatch", id: "bad.option.wrong-command.drive", argv: ["drive", "file", "ls", MISSING_ID, "--limit", "1"], expect: "error", code: USAGE_ERROR },
  { group: "dispatch", id: "arity.app.status", argv: ["app", "status", "extra"], expect: "error", code: USAGE_ERROR, match: ["Usage: paodo app status"] },
  { group: "dispatch", id: "arity.app.models", argv: ["app", "models", "extra"], expect: "error", code: USAGE_ERROR },
  { group: "dispatch", id: "arity.workspace.ls", argv: ["workspace", "ls", "extra"], expect: "error", code: USAGE_ERROR },
  { group: "dispatch", id: "arity.workspace.get.none", argv: ["workspace", "get"], expect: "error", code: USAGE_ERROR, match: ["Usage: paodo workspace get <workspace-id>"] },
  { group: "dispatch", id: "arity.workspace.get.two", argv: ["workspace", "get", "a", "b"], expect: "error", code: USAGE_ERROR },
  { group: "dispatch", id: "guard.workspace.get.empty-id", argv: ["workspace", "get", ""], expect: "error", code: USAGE_ERROR, match: ["Workspace id is required."] },
  { group: "dispatch", id: "arity.workspace.rm.none", argv: ["workspace", "rm"], expect: "error", code: USAGE_ERROR },
  { group: "dispatch", id: "arity.workspace.rm.two", argv: ["workspace", "rm", "a", "b"], expect: "error", code: USAGE_ERROR },
  { group: "dispatch", id: "guard.workspace.rm.empty-id", argv: ["workspace", "rm", ""], expect: "error", code: USAGE_ERROR, match: ["Workspace id is required."] },
  { group: "dispatch", id: "arity.workspace.create.none", argv: ["workspace", "create"], expect: "error", code: USAGE_ERROR },
  { group: "dispatch", id: "guard.workspace.create.blank", argv: ["workspace", "create", "   "], expect: "error", code: USAGE_ERROR, match: ["Workspace name is required."] },
  { group: "dispatch", id: "guard.workspace.create.surplus", argv: ["workspace", "create", "UX", "probe"], expect: "error", code: USAGE_ERROR, match: ["surplus"] },
  // The exact mistake create.mjs exists to refuse: `set`'s spelling carried over, which used to create a
  // workspace named after the assignment and report it as a success.
  { group: "dispatch", id: "guard.workspace.create.field-spelling", argv: ["workspace", "create", "UX probe 3", "llmProvider=openai"], expect: "error", code: USAGE_ERROR, match: ["surplus", "paodo workspace set"] },
  { group: "dispatch", id: "arity.workspace.set.none", argv: ["workspace", "set"], expect: "error", code: USAGE_ERROR },
  { group: "dispatch", id: "arity.workspace.set.id-only", argv: ["workspace", "set", MISSING_ID], expect: "error", code: USAGE_ERROR, match: ["Usage: paodo workspace set"] },
  { group: "dispatch", id: "guard.workspace.set.no-equals", argv: ["workspace", "set", MISSING_ID, "name"], expect: "error", code: USAGE_ERROR, match: ["Expected field=value"] },
  { group: "dispatch", id: "guard.workspace.set.leading-equals", argv: ["workspace", "set", MISSING_ID, "=value"], expect: "error", code: USAGE_ERROR, match: ["Expected field=value"] },
  { group: "dispatch", id: "guard.workspace.set.duplicate-field", argv: ["workspace", "set", MISSING_ID, "name=a", "name=b"], expect: "error", code: USAGE_ERROR, match: ["more than once"] },
  { group: "dispatch", id: "arity.key.generate.id-only", argv: ["workspace", "key", "generate", MISSING_ID], expect: "error", code: USAGE_ERROR },
  { group: "dispatch", id: "arity.key.generate.three", argv: ["workspace", "key", "generate", MISSING_ID, "api", "extra"], expect: "error", code: USAGE_ERROR },
  // In `app`, not `dispatch`: which channels exist is the app's contract, so the refusal lists what it published.
  { group: "app", id: "guard.key.channel.bogus", argv: ["workspace", "key", "generate", MISSING_ID, "http"], expect: "error", code: USAGE_ERROR, match: ['Channel must be "api" or "mcp"'] },
  { group: "app", id: "guard.key.channel.case-sensitive", argv: ["workspace", "key", "generate", MISSING_ID, "API"], expect: "error", code: USAGE_ERROR, match: ['Channel must be "api" or "mcp"'] },
  { group: "app", id: "guard.key.channel.empty", argv: ["workspace", "key", "rotate", MISSING_ID, ""], expect: "error", code: USAGE_ERROR, match: ["got nothing"] },
  { group: "dispatch", id: "guard.key.empty-id", argv: ["workspace", "key", "revoke", "", "api"], expect: "error", code: USAGE_ERROR, match: ["Workspace id is required."] },

  // The file group's own arity and guards, under both nouns. The implementation is one, so the second
  // noun is checked at the points where mounting it could have gone wrong — the id guard, which names
  // its noun, and one option refusal — rather than by running the whole list twice.
  { group: "dispatch", id: "arity.file.ls.none", argv: ["workspace", "file", "ls"], expect: "error", code: USAGE_ERROR },
  { group: "dispatch", id: "arity.file.ls.three", argv: ["workspace", "file", "ls", MISSING_ID, "a", "b"], expect: "error", code: USAGE_ERROR },
  { group: "dispatch", id: "guard.file.ls.empty-id", argv: ["workspace", "file", "ls", ""], expect: "error", code: USAGE_ERROR, match: ["Workspace id is required."] },
  { group: "dispatch", id: "guard.drive.file.ls.empty-id", argv: ["drive", "file", "ls", ""], expect: "error", code: USAGE_ERROR, match: ["Drive id is required."], note: "the same guard, and it has to name the noun it was mounted under" },
  { group: "dispatch", id: "arity.file.cat.one", argv: ["workspace", "file", "cat", MISSING_ID], expect: "error", code: USAGE_ERROR },
  { group: "dispatch", id: "arity.file.cat.three", argv: ["workspace", "file", "cat", MISSING_ID, "a", "b"], expect: "error", code: USAGE_ERROR },
  { group: "dispatch", id: "arity.drive.file.cat.one", argv: ["drive", "file", "cat", MISSING_ID], expect: "error", code: USAGE_ERROR, match: ["Usage: paodo drive file cat"] },
  { group: "dispatch", id: "guard.file.cat.offset-no-value", argv: ["workspace", "file", "cat", MISSING_ID, "sample.txt", "--offset"], expect: "error", code: USAGE_ERROR, match: ['Option "--offset" needs a value.'] },
  { group: "dispatch", id: "guard.file.cat.offset-empty-value", argv: ["workspace", "file", "cat", MISSING_ID, "sample.txt", "--offset="], expect: "error", code: USAGE_ERROR, match: ["needs a value"] },
  { group: "dispatch", id: "guard.file.cat.offset-twice", argv: ["workspace", "file", "cat", MISSING_ID, "sample.txt", "--offset", "1", "--offset", "2"], expect: "error", code: USAGE_ERROR, match: ["more than once"] },
  { group: "dispatch", id: "guard.file.cat.offset-twice-mixed-spelling", argv: ["workspace", "file", "cat", MISSING_ID, "sample.txt", "--offset=1", "--offset", "2"], expect: "error", code: USAGE_ERROR, match: ["more than once"] },
  { group: "dispatch", id: "arity.file.get.one", argv: ["workspace", "file", "get", MISSING_ID], expect: "error", code: USAGE_ERROR },
  { group: "dispatch", id: "arity.file.get.four", argv: ["workspace", "file", "get", MISSING_ID, "a", "b", "c"], expect: "error", code: USAGE_ERROR },
  { group: "dispatch", id: "arity.file.put.one", argv: ["workspace", "file", "put", MISSING_ID], expect: "error", code: USAGE_ERROR },
  { group: "dispatch", id: "arity.file.put.four", argv: ["workspace", "file", "put", MISSING_ID, "a", "b", "c"], expect: "error", code: USAGE_ERROR },
  { group: "dispatch", id: "arity.drive.file.put.four", argv: ["drive", "file", "put", MISSING_ID, "a", "b", "c"], expect: "error", code: USAGE_ERROR, match: ["Usage: paodo drive file put"] },
  // Refused by the local walk before anything is uploaded, so no request goes out for a source that
  // cannot be read — and no request goes out for one the format cannot carry, either.
  { group: "dispatch", id: "guard.file.put.missing-source", argv: ["workspace", "file", "put", MISSING_ID, "does-not-exist.txt"], expect: "error", code: USAGE_ERROR, match: ["Source does not exist"] },
  { group: "dispatch", id: "guard.drive.file.put.missing-source", argv: ["drive", "file", "put", MISSING_ID, "does-not-exist.txt"], expect: "error", code: USAGE_ERROR, match: ["Source does not exist"] },
  { group: "dispatch", id: "guard.file.put.symlink-source", argv: ["workspace", "file", "put", MISSING_ID, "link.txt"], expect: "error", code: "CLI_UNSUPPORTED_FILE", match: ["not a regular file or directory"] },
  { group: "dispatch", id: "guard.file.put.dash-source-unquoted", argv: ["workspace", "file", "put", MISSING_ID, "-dash.txt"], expect: "error", code: USAGE_ERROR, match: ["Unknown option"] },
  { group: "dispatch", id: "arity.file.rm.one", argv: ["workspace", "file", "rm", MISSING_ID], expect: "error", code: USAGE_ERROR },
  { group: "dispatch", id: "arity.file.rm.three", argv: ["workspace", "file", "rm", MISSING_ID, "a", "b"], expect: "error", code: USAGE_ERROR },

  // The drive's own five verbs.
  { group: "dispatch", id: "arity.drive.ls", argv: ["drive", "ls", "extra"], expect: "error", code: USAGE_ERROR, match: ["Usage: paodo drive ls"] },
  { group: "dispatch", id: "arity.drive.get.none", argv: ["drive", "get"], expect: "error", code: USAGE_ERROR, match: ["Usage: paodo drive get <drive-id>"] },
  { group: "dispatch", id: "arity.drive.get.two", argv: ["drive", "get", "a", "b"], expect: "error", code: USAGE_ERROR },
  { group: "dispatch", id: "guard.drive.get.empty-id", argv: ["drive", "get", ""], expect: "error", code: USAGE_ERROR, match: ["Drive id is required."] },
  { group: "dispatch", id: "arity.drive.rm.none", argv: ["drive", "rm"], expect: "error", code: USAGE_ERROR },
  { group: "dispatch", id: "arity.drive.rm.two", argv: ["drive", "rm", "a", "b"], expect: "error", code: USAGE_ERROR },
  { group: "dispatch", id: "guard.drive.rm.empty-id", argv: ["drive", "rm", ""], expect: "error", code: USAGE_ERROR, match: ["Drive id is required."], note: "an empty id builds a URL that is the collection, and the collection is every drive there is" },
  { group: "dispatch", id: "arity.drive.create.none", argv: ["drive", "create"], expect: "error", code: USAGE_ERROR },
  { group: "dispatch", id: "guard.drive.create.blank", argv: ["drive", "create", "   "], expect: "error", code: USAGE_ERROR, match: ["Drive name is required."] },
  // A description is one argument, like the name — a third word is not joined into it.
  { group: "dispatch", id: "guard.drive.create.surplus", argv: ["drive", "create", "Shared assets", "scratch", "notes"], expect: "error", code: USAGE_ERROR, match: ["surplus"] },
  // `drive set`'s spelling carried into the description slot, where it would be taken literally and
  // describe the drive as "description=scratch" — the drive-side twin of the workspace guard above.
  { group: "dispatch", id: "guard.drive.create.field-spelling", argv: ["drive", "create", "Shared assets", "description=scratch"], expect: "error", code: USAGE_ERROR, match: ["plain argument", "paodo drive create"] },
  { group: "dispatch", id: "arity.drive.set.none", argv: ["drive", "set"], expect: "error", code: USAGE_ERROR },
  { group: "dispatch", id: "arity.drive.set.id-only", argv: ["drive", "set", MISSING_ID], expect: "error", code: USAGE_ERROR, match: ["Usage: paodo drive set"] },
  { group: "dispatch", id: "guard.drive.set.no-equals", argv: ["drive", "set", MISSING_ID, "name"], expect: "error", code: USAGE_ERROR, match: ["Expected field=value"] },
  { group: "dispatch", id: "guard.drive.set.leading-equals", argv: ["drive", "set", MISSING_ID, "=value"], expect: "error", code: USAGE_ERROR, match: ["Expected field=value"] },
  { group: "dispatch", id: "guard.drive.set.duplicate-field", argv: ["drive", "set", MISSING_ID, "name=a", "name=b"], expect: "error", code: USAGE_ERROR, match: ["more than once"] },
  { group: "dispatch", id: "guard.drive.set.empty-id", argv: ["drive", "set", "", "name=x"], expect: "error", code: USAGE_ERROR, match: ["Drive id is required."] },

  // Connections. Three of these never reach the app: the id prefix says which graph a removal belongs
  // to, and a connection joining a thing to itself is refused before either id is looked up.
  { group: "dispatch", id: "arity.connection.ls.two", argv: ["connection", "ls", "a", "b"], expect: "error", code: USAGE_ERROR, match: ["Usage: paodo connection ls"] },
  { group: "dispatch", id: "guard.connection.ls.empty-id", argv: ["connection", "ls", ""], expect: "error", code: USAGE_ERROR, match: ["Workspace or drive id is required."] },
  { group: "dispatch", id: "arity.connection.create.none", argv: ["connection", "create"], expect: "error", code: USAGE_ERROR },
  { group: "dispatch", id: "arity.connection.create.one", argv: ["connection", "create", MISSING_ID], expect: "error", code: USAGE_ERROR, match: ["Usage: paodo connection create"] },
  { group: "dispatch", id: "arity.connection.create.three", argv: ["connection", "create", MISSING_ID, MISSING_ID_2, "extra"], expect: "error", code: USAGE_ERROR },
  { group: "app", id: "guard.connection.create.same-id", argv: ["connection", "create", MISSING_ID, MISSING_ID], expect: "error", code: "INVALID_REQUEST", match: ["both ids are the same"], note: "the app's refusal: which pairs may be connected is its rule, so the CLI sends the pair and relays the answer" },
  { group: "dispatch", id: "arity.connection.rm.none", argv: ["connection", "rm"], expect: "error", code: USAGE_ERROR },
  { group: "dispatch", id: "arity.connection.rm.two", argv: ["connection", "rm", MISSING_LINK_ID, "extra"], expect: "error", code: USAGE_ERROR },
  // A workspace or drive id is not a connection id, and the refusal has to say so rather than send it
  // to a route that would answer NOT_FOUND for a request that was never coherent.
  { group: "app", id: "guard.connection.rm.resource-id", argv: ["connection", "rm", MISSING_ID], expect: "error", code: "INVALID_REQUEST", match: ["is not a connection id", "link_", "call_"] },
  { group: "app", id: "guard.connection.rm.bare-prefix", argv: ["connection", "rm", "link_"], expect: "error", code: "INVALID_REQUEST", match: ["is not a connection id"], note: "the prefix alone names no connection" },
  { group: "app", id: "guard.connection.rm.unknown-prefix", argv: ["connection", "rm", "edge_abc"], expect: "error", code: "INVALID_REQUEST", match: ["is not a connection id"] },

  // ---- config: cli/src/config.mjs, every refusal, driven by the child's environment ----
  { group: "config", id: "config.no-endpoint", argv: ["app", "status"], env: { PAODO_ENDPOINT: "" }, expect: "error", code: CONFIG_ERROR, match: ["Configure PAODO_ENDPOINT and PAODO_TOKEN"] },
  { group: "config", id: "config.no-token", argv: ["app", "status"], env: { PAODO_TOKEN: "" }, expect: "error", code: CONFIG_ERROR, match: ["Configure PAODO_ENDPOINT and PAODO_TOKEN"] },
  { group: "config", id: "config.whitespace-token", argv: ["app", "status"], env: { PAODO_TOKEN: "   " }, expect: "error", code: CONFIG_ERROR, note: "trimmed to empty, so it is missing rather than sent as blanks" },
  { group: "config", id: "config.not-a-url", argv: ["app", "status"], env: { PAODO_ENDPOINT: "not a url" }, expect: "error", code: CONFIG_ERROR, match: ["must be a valid HTTP or HTTPS URL"] },
  { group: "config", id: "config.wrong-protocol", argv: ["app", "status"], env: { PAODO_ENDPOINT: "ftp://example.invalid/" }, expect: "error", code: CONFIG_ERROR, match: ["must use http or https"] },
  { group: "config", id: "config.credentials-in-url", argv: ["app", "status"], env: { PAODO_ENDPOINT: "https://user:pass@example.invalid" }, expect: "error", code: CONFIG_ERROR, match: ["must not contain credentials, a query, or a fragment"] },
  { group: "config", id: "config.query-in-url", argv: ["app", "status"], env: { PAODO_ENDPOINT: "https://example.invalid/?a=1" }, expect: "error", code: CONFIG_ERROR, match: ["must not contain credentials, a query, or a fragment"] },
  { group: "config", id: "config.fragment-in-url", argv: ["app", "status"], env: { PAODO_ENDPOINT: "https://example.invalid/#frag" }, expect: "error", code: CONFIG_ERROR, match: ["must not contain credentials, a query, or a fragment"] },
  // The config is resolved once per process and every command goes through it, so one command that
  // reaches a different noun's routes is checked too — a client built per command would drift here.
  { group: "config", id: "config.no-endpoint.drive", argv: ["drive", "ls"], env: { PAODO_ENDPOINT: "" }, expect: "error", code: CONFIG_ERROR },
  { group: "config", id: "config.no-endpoint.connection", argv: ["connection", "ls"], env: { PAODO_ENDPOINT: "" }, expect: "error", code: CONFIG_ERROR },
  // Not a config error: the trailing slashes are stripped and the request is attempted, which is the
  // only way to see that the strip happened rather than being rejected or doubled into the route.
  { group: "config", id: "config.trailing-slashes-stripped", argv: ["app", "status"], env: (c) => ({ PAODO_ENDPOINT: `http://127.0.0.1:${c.closedPort}///` }), expect: "error", code: "NETWORK_CONNECTION_REFUSED", needs: ["closedPort"] },
  { group: "config", id: "network.connection-refused", argv: ["app", "status"], env: (c) => ({ PAODO_ENDPOINT: `http://127.0.0.1:${c.closedPort}` }), expect: "error", code: "NETWORK_CONNECTION_REFUSED", needs: ["closedPort"], match: ["causeCode : ECONNREFUSED"] },
  // Fails on a machine whose shell exports HTTP_PROXY: the request goes to the proxy, which answers for
  // a host it will not tunnel to, so the name is never looked up and the code is NETWORK_ERROR. That is
  // the environment, not the CLI — unset the proxy variables to run this one.
  { group: "config", id: "network.dns-error", argv: ["app", "status"], env: { PAODO_ENDPOINT: "http://no-such-host.invalid" }, expect: "error", code: "NETWORK_DNS_ERROR", match: ["could not be resolved"], note: "needs a direct route out: a forward proxy answers before any DNS lookup happens" },

  // ---- transport: the answers a healthy app never gives, served from 127.0.0.1 ----
  { group: "transport", id: "transport.redirect-refused", argv: ["app", "status"], env: stubEnv("redirect"), needs: ["stub"], expect: "error", code: "INVALID_RESPONSE", match: ["redirected the request"] },
  { group: "transport", id: "transport.non-json-success", argv: ["app", "status"], env: stubEnv("html"), needs: ["stub"], expect: "error", code: "INVALID_RESPONSE", match: ["non-JSON success response", "text/html"] },
  { group: "transport", id: "transport.invalid-json", argv: ["app", "status"], env: stubEnv("badjson"), needs: ["stub"], expect: "error", code: "INVALID_RESPONSE", match: ["returned invalid JSON"] },
  // Relayed verbatim, including the app's own code, wording and requestId — the CLI never paraphrases
  // a rejection the app already worded.
  { group: "transport", id: "transport.app-envelope-relayed", argv: ["workspace", "get", MISSING_ID], env: stubEnv("apperror"), needs: ["stub"], expect: "error", code: "STUB_APP_REFUSAL", match: ["the app said no, in its own words", "rid-stub-1"] },
  { group: "transport", id: "transport.app-envelope-relayed.drive", argv: ["drive", "get", MISSING_ID], env: stubEnv("apperror"), needs: ["stub"], expect: "error", code: "STUB_APP_REFUSAL", match: ["the app said no, in its own words"] },
  { group: "transport", id: "transport.plain-text-error", argv: ["app", "status"], env: stubEnv("plainerror"), needs: ["stub"], expect: "error", code: "CLI_HTTP_SERVICE_UNAVAILABLE", match: ["upstream is down"] },
  { group: "transport", id: "transport.unmapped-status", argv: ["app", "status"], env: stubEnv("teapot"), needs: ["stub"], expect: "error", code: "HTTP_418" },
  // Every row of CODE_BY_STATUS, one case each. These codes fire only when the app gave no `code` of its
  // own, so each is a guess from the raw status — and one row silently drifting would otherwise surface
  // as an authoritative-looking answer the app never gave.
  ...Object.entries({
    400: "CLI_HTTP_INVALID_REQUEST",
    401: "CLI_HTTP_UNAUTHORIZED",
    403: "CLI_HTTP_FORBIDDEN",
    404: "CLI_HTTP_NOT_FOUND",
    409: "CLI_HTTP_CONFLICT",
    429: "CLI_HTTP_RATE_LIMITED",
    500: "CLI_HTTP_INTERNAL_ERROR",
    503: "CLI_HTTP_SERVICE_UNAVAILABLE",
  }).map(([status, code]) => ({
    group: "transport",
    id: `transport.status.${status}`,
    argv: ["app", "status"],
    env: stubEnv(`status/${status}`),
    needs: ["stub"],
    expect: "error",
    code,
    match: ["no envelope here"],
  })),
  // The three listings whose reply carries no `ok` of its own, so each has to check the shape itself
  // rather than trust one there is nowhere to put.
  { group: "transport", id: "transport.workspace-list-not-array", argv: ["workspace", "ls"], env: stubEnv("notarray"), needs: ["stub"], expect: "error", code: "INVALID_RESPONSE", match: ["invalid workspace list"] },
  { group: "transport", id: "transport.drive-list-not-array", argv: ["drive", "ls"], env: stubEnv("notarray"), needs: ["stub"], expect: "error", code: "INVALID_RESPONSE", match: ["invalid drive list"] },
  // `connection ls` relays whatever groups the app names, so a reply holding no group at all has to
  // surface as a refusal rather than as a listing with nothing in it.
  { group: "transport", id: "transport.connection-listing-has-no-groups", argv: ["connection", "ls"], env: stubEnv("notarray"), needs: ["stub"], expect: "error", code: "INVALID_RESPONSE", match: ["invalid connection listing"] },
  // An archive with no entries at all. Not the `!response.body` guard — fetch hands over a body stream
  // even for a zero-length 200, so that one is unreachable over HTTP and is the only guard in
  // extractResponse this group does not cover.
  { group: "transport", id: "transport.transfer-no-payload-entry", argv: ["workspace", "file", "get", MISSING_ID, "sample.txt", "pulled/stub-a"], env: stubEnv("emptytar"), needs: ["stub"], expect: "error", code: "INVALID_RESPONSE", match: ["no payload entry"] },
  { group: "transport", id: "transport.transfer-outside-payload", argv: ["workspace", "file", "get", MISSING_ID, "sample.txt", "pulled/stub-b"], env: stubEnv("outsidepayload"), needs: ["stub"], expect: "error", code: "INVALID_RESPONSE", match: ["outside payload"] },
  // A child arriving before any root entry: the payload is not known to be a directory, so a path under
  // it cannot be placed. The earlier of the two guards a rootless archive can trip.
  { group: "transport", id: "transport.transfer-child-under-file-payload", argv: ["workspace", "file", "get", MISSING_ID, "sample.txt", "pulled/stub-c"], env: stubEnv("nopayloadroot"), needs: ["stub"], expect: "error", code: "INVALID_RESPONSE", match: ["child entries under a file payload"] },
  { group: "transport", id: "transport.transfer-duplicate-entry", argv: ["workspace", "file", "get", MISSING_ID, "sample.txt", "pulled/stub-d"], env: stubEnv("duplicate"), needs: ["stub"], expect: "error", code: "INVALID_RESPONSE", match: ["duplicate entry"] },
  { group: "transport", id: "transport.transfer-unsupported-entry", argv: ["workspace", "file", "get", MISSING_ID, "sample.txt", "pulled/stub-e"], env: stubEnv("unsupportedentry"), needs: ["stub"], expect: "error", code: "INVALID_RESPONSE", match: ["unsupported entry"] },
  // The same transport under the other noun. One case, because what is being checked is that the drive
  // mounting rides the same archive guards, not the guards themselves a second time.
  { group: "transport", id: "transport.transfer-guards-under-drive", argv: ["drive", "file", "get", MISSING_ID, "sample.txt", "pulled/stub-f"], env: stubEnv("emptytar"), needs: ["stub"], expect: "error", code: "INVALID_RESPONSE", match: ["no payload entry"] },
  // A pull that fails must leave nothing half-written where it was going to land.
  { group: "transport", id: "transport.failed-pull-left-nothing", argv: ["workspace", "file", "ls", MISSING_ID], env: stubEnv("apperror"), needs: ["stub"], expect: "error", localCheck: () => (fs.existsSync(path.join(TMP, "pulled", "stub-b")) ? ["a failed pull left pulled/stub-b behind"] : []) },

  // ---- reads that need the app but nothing of our own ----
  { group: "app", id: "app.status", argv: ["app", "status"], expect: "receipt", match: ["status :"] },
  {
    group: "app",
    id: "app.models",
    argv: ["app", "models"],
    expect: "receipt",
    match: ["providers"],
    // The set `workspace set llmProvider=/llmModel=/reasoningEffort=` is validated against, so the
    // lifecycle group configures a combination the app actually offers rather than a hardcoded one that
    // goes stale the next time the model list changes.
    //
    // Scoped to the first provider's own block rather than searched for across the whole output: the
    // `models :` line of one provider and the `reasoningEfforts :` line of another are each valid on
    // their own and invalid together, and that is precisely the pairing a whole-output search can pick.
    capture(out, ctx) {
      const providersAt = out.indexOf("providers :");
      if (providersAt === -1) return;
      const body = out.slice(providersAt + "providers :".length);
      const provider = /^([A-Za-z0-9_-]+)\s*:\s*$/m.exec(body);
      if (!provider) return;
      const block = body.slice(provider.index + provider[0].length);
      const nextHeader = /^[A-Za-z0-9_-]+\s*:\s*$/m.exec(block);
      const scoped = nextHeader ? block.slice(0, nextHeader.index) : block;
      const models = /^models\s*:\s*(.+)$/im.exec(scoped);
      const efforts = /^reasoningEfforts\s*:\s*(.+)$/im.exec(scoped);
      if (!models) return;
      ctx.llmProvider = provider[1];
      ctx.llmModel = models[1].split(",")[0].trim();
      if (efforts && efforts[1].trim() !== "(none)") ctx.reasoningEffort = efforts[1].split(",")[0].trim();
    },
  },
  { group: "app", id: "workspace.ls", argv: ["workspace", "ls"], expect: "receipt", match: ["workspaces"] },
  { group: "app", id: "drive.ls", argv: ["drive", "ls"], expect: "receipt", match: ["drives"] },
  {
    group: "app",
    id: "connection.ls.all",
    argv: ["connection", "ls"],
    expect: "receipt",
    // Both kinds are always there, each as a list: the app serves both graphs unconditionally.
    match: ["driveLinks", "agentCalls"],
  },
  { group: "app", id: "workspace.get.missing", argv: ["workspace", "get", MISSING_ID], expect: "error" },
  { group: "app", id: "workspace.set.missing", argv: ["workspace", "set", MISSING_ID, "name=nope"], expect: "error" },
  { group: "app", id: "file.ls.missing-workspace", argv: ["workspace", "file", "ls", MISSING_ID], expect: "error" },
  { group: "app", id: "drive.get.missing", argv: ["drive", "get", MISSING_ID], expect: "error" },
  { group: "app", id: "drive.set.missing", argv: ["drive", "set", MISSING_ID, "name=nope"], expect: "error" },
  { group: "app", id: "drive.file.ls.missing-drive", argv: ["drive", "file", "ls", MISSING_ID], expect: "error" },
  { group: "app", id: "workspace.get.not-a-uuid", argv: ["workspace", "get", "../../etc/passwd"], expect: "error", note: "an id is encoded, so it cannot become a different route" },
  { group: "app", id: "drive.get.not-a-uuid", argv: ["drive", "get", "../../etc/passwd"], expect: "error" },
  // An id in neither registry is refused by the app — not answered with an empty listing, which is
  // what "nothing is connected to it" looks like and is the one thing it must not be confused with.
  { group: "app", id: "connection.ls.unknown-id", argv: ["connection", "ls", MISSING_ID], expect: "error", code: "NOT_FOUND", match: ["no workspace or drive has the id"] },
  { group: "app", id: "connection.create.unknown-ids", argv: ["connection", "create", MISSING_ID, MISSING_ID_2], expect: "error", code: "NOT_FOUND", match: ["no workspace or drive has the id"] },
  // `deleted : false` is the documented answer for an id that is connected to nothing — including one
  // already removed, and one whose workspace or drive went away since `ls` printed it. A refusal here
  // would mean a caller cleaning up dangling links has to tell "already gone" from "went wrong".
  { group: "app", id: "connection.rm.never-existed", argv: ["connection", "rm", MISSING_LINK_ID], expect: "receipt", match: ["deleted : false"], note: "removing what is not there is an answer, not a failure" },

  // ---- the workspaces this suite owns ----
  {
    group: "workspace",
    id: "workspace.create",
    argv: ["workspace", "create", WS_NAME],
    expect: "receipt",
    match: ["workspaceId"],
    capture(out, ctx) {
      ctx.ws = /^workspaceId\s*:\s*(\S+)$/im.exec(out)?.[1];
    },
  },
  { group: "workspace", id: "workspace.get", needs: ["ws"], argv: (c) => ["workspace", "get", c.ws], expect: "receipt", match: ["workspace :", `name : ${WS_NAME}`] },
  // Present from the start and zero, so a caller reading it never has to tell "none" from "not reported".
  { group: "workspace", id: "workspace.get.counts-connections", needs: ["ws"], argv: (c) => ["workspace", "get", c.ws], expect: "receipt", match: ["connections"] },
  { group: "workspace", id: "set.name", needs: ["ws"], argv: (c) => ["workspace", "set", c.ws, `name=${WS_NAME}-renamed`], expect: "receipt", match: ["applied :", `name : ${WS_NAME}-renamed`] },
  // A quoted multi-word value has to arrive as one value, spaces and all.
  { group: "workspace", id: "set.name.with-spaces", needs: ["ws"], argv: (c) => ["workspace", "set", c.ws, `name=${WS_SPACED}`], expect: "receipt" },
  { group: "workspace", id: "set.name.with-spaces.readback", needs: ["ws"], argv: (c) => ["workspace", "get", c.ws], expect: "receipt", match: [`name : ${WS_SPACED}`] },
  { group: "workspace", id: "set.description", needs: ["ws"], argv: (c) => ["workspace", "set", c.ws, "description=Automated CLI regression run."], expect: "receipt" },
  { group: "workspace", id: "set.description.empty", needs: ["ws"], argv: (c) => ["workspace", "set", c.ws, "description="], expect: "receipt" },
  // Only the FIRST `=` separates: the rest belongs to the value.
  { group: "workspace", id: "set.value-containing-equals", needs: ["ws"], argv: (c) => ["workspace", "set", c.ws, "description=a=b=c"], expect: "receipt" },
  { group: "workspace", id: "set.value-containing-equals.readback", needs: ["ws"], argv: (c) => ["workspace", "get", c.ws], expect: "receipt", match: ["description : a=b=c"] },
  // `--` ends option parsing, so an assignment after it is still an assignment.
  { group: "workspace", id: "set.after-dashdash", needs: ["ws"], argv: (c) => ["workspace", "set", c.ws, "--", "description=after the terminator"], expect: "receipt" },
  {
    group: "workspace",
    id: "set.model-triple",
    needs: ["ws", "llmProvider", "llmModel"],
    argv: (c) => [
      "workspace",
      "set",
      c.ws,
      `llmProvider=${c.llmProvider}`,
      `llmModel=${c.llmModel}`,
      ...(c.reasoningEffort ? [`reasoningEffort=${c.reasoningEffort}`] : []),
    ],
    expect: "receipt",
  },
  { group: "workspace", id: "set.maxIterations", needs: ["ws"], argv: (c) => ["workspace", "set", c.ws, "maxIterations=25"], expect: "receipt" },
  { group: "workspace", id: "set.maxRunMinutes", needs: ["ws"], argv: (c) => ["workspace", "set", c.ws, "maxRunMinutes=10"], expect: "receipt" },
  { group: "workspace", id: "set.internetAccess.true", needs: ["ws"], argv: (c) => ["workspace", "set", c.ws, "internetAccess=true"], expect: "receipt" },
  { group: "workspace", id: "set.internetAccess.false", needs: ["ws"], argv: (c) => ["workspace", "set", c.ws, "internetAccess=false"], expect: "receipt" },
  {
    group: "workspace",
    id: "set.every-field",
    needs: ["ws", "llmProvider", "llmModel"],
    argv: (c) => [
      "workspace",
      "set",
      c.ws,
      `name=${WS_NAME}`,
      "description=Every field in one call.",
      `llmProvider=${c.llmProvider}`,
      `llmModel=${c.llmModel}`,
      ...(c.reasoningEffort ? [`reasoningEffort=${c.reasoningEffort}`] : []),
      "maxIterations=12",
      "maxRunMinutes=5",
      "internetAccess=true",
      "workspaceApiAccess=false",
      "workspaceMcpAccess=false",
    ],
    expect: "receipt",
  },
  { group: "workspace", id: "set.readback", needs: ["ws"], argv: (c) => ["workspace", "get", c.ws], expect: "receipt", match: ["maxIterations : 12", "maxRunMinutes : 5", "internetAccess : true", `name : ${WS_NAME}`] },
  // Values travel as given and the app owns every rule, so each of these has to come back a refusal
  // rather than a receipt (see the note in cli/src/commands/workspace/set.mjs).
  { group: "workspace", id: "set.reject.unknown-field", needs: ["ws"], argv: (c) => ["workspace", "set", c.ws, "bogusField=1"], expect: "error" },
  { group: "workspace", id: "set.reject.int-not-a-number", needs: ["ws"], argv: (c) => ["workspace", "set", c.ws, "maxIterations=abc"], expect: "error" },
  { group: "workspace", id: "set.reject.int-fractional", needs: ["ws"], argv: (c) => ["workspace", "set", c.ws, "maxIterations=2.5"], expect: "error" },
  { group: "workspace", id: "set.reject.int-negative", needs: ["ws"], argv: (c) => ["workspace", "set", c.ws, "maxIterations=-5"], expect: "error" },
  { group: "workspace", id: "set.reject.bool-not-a-bool", needs: ["ws"], argv: (c) => ["workspace", "set", c.ws, "internetAccess=yes"], expect: "error" },
  { group: "workspace", id: "set.reject.unknown-model", needs: ["ws"], argv: (c) => ["workspace", "set", c.ws, "llmModel=no-such-model-9"], expect: "error" },
  { group: "workspace", id: "set.reject.unknown-provider", needs: ["ws"], argv: (c) => ["workspace", "set", c.ws, "llmProvider=no-such-provider"], expect: "error" },
  { group: "workspace", id: "set.reject.unknown-effort", needs: ["ws"], argv: (c) => ["workspace", "set", c.ws, "reasoningEffort=galaxy-brain"], expect: "error" },
  { group: "workspace", id: "set.reject.name-too-long", needs: ["ws"], argv: (c) => ["workspace", "set", c.ws, `name=${"x".repeat(101)}`], expect: "error" },
  { group: "workspace", id: "set.reject.name-empty", needs: ["ws"], argv: (c) => ["workspace", "set", c.ws, "name="], expect: "error" },
  // A rejected call must change nothing, or the refusals above are only half a contract.
  { group: "workspace", id: "set.reject.left-state-alone", needs: ["ws"], argv: (c) => ["workspace", "get", c.ws], expect: "receipt", match: ["maxIterations : 12", `name : ${WS_NAME}`] },
  // The second workspace, which exists for one thing: an agent call needs a caller and a callee, and
  // the same workspace cannot be both. Left at its defaults otherwise.
  {
    group: "workspace",
    id: "workspace.create.callee",
    argv: ["workspace", "create", WS2_NAME],
    expect: "receipt",
    match: ["workspaceId"],
    capture(out, ctx) {
      ctx.ws2 = /^workspaceId\s*:\s*(\S+)$/im.exec(out)?.[1];
    },
  },

  // ---- files: a workspace's five verbs — both path spaces, both directions, and what a transfer
  //      refuses to carry. This is the long half; the drive mounting of the same five is below. ----
  // A new workspace is not empty — it ships with .skills/ and AGENTS.md — so the first listing is the
  // template, not nothing, and it is where `contains` and `lines` are observable.
  { group: "files", id: "file.ls.root.default", needs: ["ws"], argv: (c) => ["workspace", "file", "ls", c.ws], expect: "receipt", match: ["entries", "AGENTS.md", "lines :", "contains :"] },
  { group: "files", id: "file.ls.root.slash", needs: ["ws"], argv: (c) => ["workspace", "file", "ls", c.ws, "/"], expect: "receipt", match: ["AGENTS.md"] },
  { group: "files", id: "file.ls.root.empty-string", needs: ["ws"], argv: (c) => ["workspace", "file", "ls", c.ws, ""], expect: "receipt", match: ["AGENTS.md"] },
  // `created`, `overwritten` and `ignored` are printed on every transfer receipt, so a match on the bare
  // word proves nothing — each of these names the path it expects in the list it expects, and the list
  // it expects to stay empty.
  { group: "files", id: "file.put.file.default-dest", needs: ["ws"], timeoutMs: TRANSFER_TIMEOUT, argv: (c) => ["workspace", "file", "put", c.ws, "sample.txt"], expect: "receipt", match: ["destination : workspace", "created : sample.txt", "overwritten : (none)", "ignored : (none)"] },
  { group: "files", id: "file.put.file.same-again", needs: ["ws"], timeoutMs: TRANSFER_TIMEOUT, argv: (c) => ["workspace", "file", "put", c.ws, "sample.txt"], expect: "receipt", match: ["overwritten : sample.txt", "created : (none)"] },
  // A file push names the file and not the parent it had to make, where a directory push names the
  // directories too — so this asserts the file alone rather than assuming the two spellings match.
  { group: "files", id: "file.put.file.explicit-dest", needs: ["ws"], timeoutMs: TRANSFER_TIMEOUT, argv: (c) => ["workspace", "file", "put", c.ws, "sample.txt", "notes/copy.txt"], expect: "receipt", match: ["created : notes/copy.txt"] },
  { group: "files", id: "file.put.file.leading-slash-dest", needs: ["ws"], timeoutMs: TRANSFER_TIMEOUT, argv: (c) => ["workspace", "file", "put", c.ws, "sample.txt", "/notes/slashed.txt"], expect: "receipt", match: ["notes/slashed.txt"], notMatch: ["/notes/slashed.txt"] },
  { group: "files", id: "file.put.empty-file", needs: ["ws"], timeoutMs: TRANSFER_TIMEOUT, argv: (c) => ["workspace", "file", "put", c.ws, "empty.txt"], expect: "receipt", match: ["created : empty.txt"] },
  { group: "files", id: "file.put.executable", needs: ["ws"], timeoutMs: TRANSFER_TIMEOUT, argv: (c) => ["workspace", "file", "put", c.ws, "runme.sh"], expect: "receipt", match: ["created : runme.sh"] },
  { group: "files", id: "file.put.space-in-name", needs: ["ws"], timeoutMs: TRANSFER_TIMEOUT, argv: (c) => ["workspace", "file", "put", c.ws, "with space.txt"], expect: "receipt", match: ["created : with space.txt"] },
  { group: "files", id: "file.put.dir.default-dest", needs: ["ws"], timeoutMs: TRANSFER_TIMEOUT, argv: (c) => ["workspace", "file", "put", c.ws, "tree"], expect: "receipt", match: ["tree/nested/deep/c.txt", "ignored : (none)"] },
  // "." merges the contents in rather than the directory itself, so the pushed paths lose the `tree/`
  // prefix — the one spelling difference between this and the case above.
  { group: "files", id: "file.put.dir.merge-into-root", needs: ["ws"], timeoutMs: TRANSFER_TIMEOUT, argv: (c) => ["workspace", "file", "put", c.ws, "tree", "."], expect: "receipt", match: ["nested/deep/c.txt"] },
  // The app applies its own ignore contract on arrival; the CLI does not pre-filter, so what was
  // refused has to come back named rather than silently missing — and what was kept has to arrive.
  { group: "files", id: "file.put.dir.with-ignored-paths", needs: ["ws"], timeoutMs: TRANSFER_TIMEOUT, argv: (c) => ["workspace", "file", "put", c.ws, "withmods"], expect: "receipt", match: ["created : withmods, withmods/keep.txt", "ignored : withmods/node_modules"], notMatch: ["ignored : (none)"] },
  // `--` is what makes a dash-leading path a path; the unquoted form is refused in the dispatch group.
  { group: "files", id: "file.put.dash-name", needs: ["ws"], timeoutMs: TRANSFER_TIMEOUT, argv: (c) => ["workspace", "file", "put", c.ws, "--", "-dash.txt"], expect: "receipt" },
  { group: "files", id: "file.put.binary", needs: ["ws"], timeoutMs: TRANSFER_TIMEOUT, argv: (c) => ["workspace", "file", "put", c.ws, "blob.bin"], expect: "receipt" },
  { group: "files", id: "file.ls.subdir", needs: ["ws"], argv: (c) => ["workspace", "file", "ls", c.ws, "tree"], expect: "receipt", match: ["tree/nested/", "tree/a.txt"] },
  { group: "files", id: "file.ls.subdir.leading-slash", needs: ["ws"], argv: (c) => ["workspace", "file", "ls", c.ws, "/tree/nested"], expect: "receipt" },
  { group: "files", id: "file.ls.subdir.trailing-slash", needs: ["ws"], argv: (c) => ["workspace", "file", "ls", c.ws, "tree/nested/"], expect: "receipt" },
  // One level per call, so a grandchild must NOT appear in a listing of its grandparent.
  { group: "files", id: "file.ls.is-one-level", needs: ["ws"], argv: (c) => ["workspace", "file", "ls", c.ws, "tree"], expect: "receipt", notMatch: ["tree/nested/b.txt", "tree/nested/deep"] },
  { group: "files", id: "file.ls.missing-path", needs: ["ws"], argv: (c) => ["workspace", "file", "ls", c.ws, "no/such/dir"], expect: "error" },
  { group: "files", id: "file.ls.on-a-file", needs: ["ws"], argv: (c) => ["workspace", "file", "ls", c.ws, "sample.txt"], expect: "receipt", note: "listing a file names the file" },
  { group: "files", id: "file.cat.whole", needs: ["ws"], argv: (c) => ["workspace", "file", "cat", c.ws, "sample.txt"], expect: "ok", match: ["line 1", "line 10"] },
  { group: "files", id: "file.cat.offset", needs: ["ws"], argv: (c) => ["workspace", "file", "cat", c.ws, "sample.txt", "--offset", "5"], expect: "ok", match: ["line 6", "line 10"], notMatch: ["line 5"] },
  { group: "files", id: "file.cat.limit", needs: ["ws"], argv: (c) => ["workspace", "file", "cat", c.ws, "sample.txt", "--limit", "2"], expect: "ok", match: ["line 1", "line 2"], notMatch: ["line 5"] },
  { group: "files", id: "file.cat.window", needs: ["ws"], argv: (c) => ["workspace", "file", "cat", c.ws, "sample.txt", "--offset", "3", "--limit", "2"], expect: "ok", match: ["line 4", "line 5"], notMatch: ["line 7"] },
  { group: "files", id: "file.cat.window.equals-form", needs: ["ws"], argv: (c) => ["workspace", "file", "cat", c.ws, "sample.txt", "--offset=3", "--limit=2"], expect: "ok", match: ["line 4", "line 5"], notMatch: ["line 7"] },
  // 0-based, matching the workspace agent's own file_read tool — an off-by-one here has no symptom
  // other than wrong content.
  { group: "files", id: "file.cat.offset-zero-is-first-line", needs: ["ws"], argv: (c) => ["workspace", "file", "cat", c.ws, "sample.txt", "--offset", "0", "--limit", "1"], expect: "ok", match: ["line 1"], notMatch: ["line 2"] },
  { group: "files", id: "file.cat.nested", needs: ["ws"], argv: (c) => ["workspace", "file", "cat", c.ws, "tree/nested/deep/c.txt"], expect: "ok", match: ["tree nested deep c"] },
  { group: "files", id: "file.cat.dash-name", needs: ["ws"], argv: (c) => ["workspace", "file", "cat", c.ws, "--", "-dash.txt"], expect: "ok", match: ["dashed name"] },
  { group: "files", id: "file.cat.space-in-name", needs: ["ws"], argv: (c) => ["workspace", "file", "cat", c.ws, "with space.txt"], expect: "ok", match: ["spaced file name"] },
  { group: "files", id: "file.cat.empty-file", needs: ["ws"], argv: (c) => ["workspace", "file", "cat", c.ws, "empty.txt"], expect: "ok" },
  // Bytes a terminal cannot show, and an agent would have to carry for the rest of its context: refused
  // on the media type the app itself classified, before any of it is written to stdout.
  { group: "files", id: "file.cat.reject.binary", needs: ["ws"], argv: (c) => ["workspace", "file", "cat", c.ws, "blob.bin"], expect: "error", code: "CLI_NOT_TEXT_FILE", match: ["not a text file", "paodo workspace file get"] },
  // The app owns what a value may say, so a bad window is its refusal, not a second copy of the rule here.
  { group: "files", id: "file.cat.reject.offset-not-int", needs: ["ws"], argv: (c) => ["workspace", "file", "cat", c.ws, "sample.txt", "--offset", "abc"], expect: "error" },
  { group: "files", id: "file.cat.reject.offset-negative", needs: ["ws"], argv: (c) => ["workspace", "file", "cat", c.ws, "sample.txt", "--offset", "-1"], expect: "error" },
  { group: "files", id: "file.cat.reject.limit-zero", needs: ["ws"], argv: (c) => ["workspace", "file", "cat", c.ws, "sample.txt", "--limit", "0"], expect: "error" },
  { group: "files", id: "file.cat.reject.window-on-binary", needs: ["ws"], argv: (c) => ["workspace", "file", "cat", c.ws, "blob.bin", "--offset", "0", "--limit", "1"], expect: "error" },
  { group: "files", id: "file.cat.reject.missing", needs: ["ws"], argv: (c) => ["workspace", "file", "cat", c.ws, "no/such/file.txt"], expect: "error" },
  { group: "files", id: "file.cat.reject.directory", needs: ["ws"], argv: (c) => ["workspace", "file", "cat", c.ws, "tree"], expect: "error" },
  { group: "files", id: "file.cat.offset-past-eof", needs: ["ws"], argv: (c) => ["workspace", "file", "cat", c.ws, "sample.txt", "--offset", "999"], expect: "ok", notMatch: ["line 1"], note: "a window past the end is empty, not an error" },
  { group: "files", id: "file.get.file.default-dest", needs: ["ws"], timeoutMs: TRANSFER_TIMEOUT, argv: (c) => ["workspace", "file", "get", c.ws, "sample.txt"], expect: "receipt", match: ["destination : local"] },
  // `created` here names absolute paths on THIS machine, which is what `destination : local` is for.
  { group: "files", id: "file.get.file.explicit-dest", needs: ["ws"], timeoutMs: TRANSFER_TIMEOUT, argv: (c) => ["workspace", "file", "get", c.ws, "sample.txt", "pulled/sample.txt"], expect: "receipt", match: ["pulled/sample.txt", "overwritten : (none)"], notMatch: ["created : (none)"], localCheck: () => (fs.readFileSync(path.join(TMP, "pulled/sample.txt"), "utf8").includes("line 7") ? [] : ["the pulled file does not have the content that was pushed"]) },
  { group: "files", id: "file.get.file.overwrite", needs: ["ws"], timeoutMs: TRANSFER_TIMEOUT, argv: (c) => ["workspace", "file", "get", c.ws, "sample.txt", "pulled/sample.txt"], expect: "receipt", match: ["created : (none)"], notMatch: ["overwritten : (none)"] },
  { group: "files", id: "file.get.dir", needs: ["ws"], timeoutMs: TRANSFER_TIMEOUT, argv: (c) => ["workspace", "file", "get", c.ws, "tree", "pulled/tree"], expect: "receipt", notMatch: ["created : (none)"], localCheck: () => (fs.existsSync(path.join(TMP, "pulled/tree/nested/deep/c.txt")) ? [] : ["a directory pull did not recreate the whole subtree"]) },
  { group: "files", id: "file.get.dir.trailing-slash", needs: ["ws"], timeoutMs: TRANSFER_TIMEOUT, argv: (c) => ["workspace", "file", "get", c.ws, "tree/", "pulled/tree-slash"], expect: "receipt", notMatch: ["created : (none)"], localCheck: () => (fs.existsSync(path.join(TMP, "pulled/tree-slash/a.txt")) ? [] : ["a trailing slash on the source changed what a directory pull produced"]) },
  { group: "files", id: "file.get.dir.merge-into-cwd", needs: ["ws"], timeoutMs: TRANSFER_TIMEOUT, argv: (c) => ["workspace", "file", "get", c.ws, "tree/nested", "."], expect: "receipt" },
  { group: "files", id: "file.get.executable-keeps-mode", needs: ["ws"], timeoutMs: TRANSFER_TIMEOUT, argv: (c) => ["workspace", "file", "get", c.ws, "runme.sh", "pulled/runme.sh"], expect: "receipt", localCheck: () => ((fs.statSync(path.join(TMP, "pulled/runme.sh")).mode & 0o111) !== 0 ? [] : ["an executable came back without its executable bit"]) },
  { group: "files", id: "file.get.root", needs: ["ws"], timeoutMs: TRANSFER_TIMEOUT, argv: (c) => ["workspace", "file", "get", c.ws, "/", "pulled/whole"], expect: "receipt" },
  { group: "files", id: "file.get.reject.missing", needs: ["ws"], argv: (c) => ["workspace", "file", "get", c.ws, "no/such/file.txt", "pulled/nope"], expect: "error", localCheck: () => (fs.existsSync(path.join(TMP, "pulled/nope")) ? ["a failed pull left pulled/nope behind"] : []) },
  { group: "files", id: "file.rm.file", needs: ["ws"], argv: (c) => ["workspace", "file", "rm", c.ws, "notes/copy.txt"], expect: "receipt", match: ["removed : notes/copy.txt", "removedCount : 1"] },
  // A trailing slash takes the directory and everything inside it, in one receipt.
  { group: "files", id: "file.rm.dir.trailing-slash", needs: ["ws"], argv: (c) => ["workspace", "file", "rm", c.ws, "tree/nested/"], expect: "receipt", match: ["tree/nested/deep/c.txt"], notMatch: ["removedCount : 0", "removedCount : 1\n"] },
  { group: "files", id: "file.rm.gone-after-rm", needs: ["ws"], argv: (c) => ["workspace", "file", "ls", c.ws, "tree"], expect: "receipt", notMatch: ["tree/nested/"] },
  { group: "files", id: "file.rm.dir.no-slash", needs: ["ws"], argv: (c) => ["workspace", "file", "rm", c.ws, "tree"], expect: "receipt", notMatch: ["removedCount : 0"] },
  { group: "files", id: "file.rm.dash-name", needs: ["ws"], argv: (c) => ["workspace", "file", "rm", c.ws, "--", "-dash.txt"], expect: "receipt", match: ["removed : -dash.txt"] },
  { group: "files", id: "file.rm.reject.missing", needs: ["ws"], argv: (c) => ["workspace", "file", "rm", c.ws, "no/such/file.txt"], expect: "error" },
  // Root is the UI's select-all-and-delete: one delete per top-level entry, summed into one receipt. The
  // template files a new workspace ships with are in that sum, so it is never a no-op here.
  { group: "files", id: "file.rm.root.slash", needs: ["ws"], timeoutMs: TRANSFER_TIMEOUT, argv: (c) => ["workspace", "file", "rm", c.ws, "/"], expect: "receipt", match: ["AGENTS.md"], notMatch: ["removedCount : 0"] },
  // The same act at zero scale, and it has to answer in the same shape rather than fail.
  { group: "files", id: "file.rm.root.already-empty", needs: ["ws"], argv: (c) => ["workspace", "file", "rm", c.ws, ""], expect: "receipt", match: ["removed : (none)", "removedCount : 0"] },
  { group: "files", id: "file.ls.after-empty", needs: ["ws"], argv: (c) => ["workspace", "file", "ls", c.ws], expect: "receipt", match: ["entries : (none)"] },

  // ---- the drives this suite owns ----
  {
    group: "drive",
    id: "drive.create",
    argv: ["drive", "create", DRIVE_NAME],
    expect: "receipt",
    match: ["driveId", "drive :"],
    capture(out, ctx) {
      ctx.drive = /^driveId\s*:\s*(\S+)$/im.exec(out)?.[1];
    },
  },
  { group: "drive", id: "drive.get", needs: ["drive"], argv: (c) => ["drive", "get", c.drive], expect: "receipt", match: ["drive :", `name : ${DRIVE_NAME}`] },
  { group: "drive", id: "drive.get.counts-connections", needs: ["drive"], argv: (c) => ["drive", "get", c.drive], expect: "receipt", match: ["connections"], note: "always present, so a zero is an answer rather than a missing field" },
  { group: "drive", id: "drive.ls.lists-it", needs: ["drive"], argv: ["drive", "ls"], expect: "receipt", match: [DRIVE_NAME] },
  // An agent addresses a drive by name, so a duplicate would be reachable only by accident. The rule is
  // the app's and is compared case- and accent-insensitively, which is why the second spelling below is
  // the same name shouted: a check that only compared bytes would let it through.
  { group: "drive", id: "drive.create.reject.duplicate-name", needs: ["drive"], argv: ["drive", "create", DRIVE_NAME], expect: "error", note: "nothing is created by a refused create, so this leaves no drive behind" },
  { group: "drive", id: "drive.create.reject.duplicate-name.case-folded", needs: ["drive"], argv: ["drive", "create", DRIVE_NAME.toUpperCase()], expect: "error" },
  // The second drive, created with a description — the two-argument form of create, and the id the
  // "two drives cannot be connected" refusal needs.
  {
    group: "drive",
    id: "drive.create.with-description",
    argv: ["drive", "create", DRIVE2_NAME, DRIVE_DESCRIPTION],
    expect: "receipt",
    match: ["driveId"],
    capture(out, ctx) {
      ctx.drive2 = /^driveId\s*:\s*(\S+)$/im.exec(out)?.[1];
    },
  },
  { group: "drive", id: "drive.create.with-description.readback", needs: ["drive2"], argv: (c) => ["drive", "get", c.drive2], expect: "receipt", match: [`name : ${DRIVE2_NAME}`, `description : ${DRIVE_DESCRIPTION}`] },
  { group: "drive", id: "drive.set.name", needs: ["drive"], argv: (c) => ["drive", "set", c.drive, `name=${DRIVE_NAME}-renamed`], expect: "receipt", match: ["applied :", `name : ${DRIVE_NAME}-renamed`] },
  { group: "drive", id: "drive.set.name.with-spaces", needs: ["drive"], argv: (c) => ["drive", "set", c.drive, `name=${DRIVE_SPACED}`], expect: "receipt" },
  { group: "drive", id: "drive.set.name.with-spaces.readback", needs: ["drive"], argv: (c) => ["drive", "get", c.drive], expect: "receipt", match: [`name : ${DRIVE_SPACED}`] },
  { group: "drive", id: "drive.set.description", needs: ["drive"], argv: (c) => ["drive", "set", c.drive, "description=Automated CLI regression run."], expect: "receipt" },
  { group: "drive", id: "drive.set.description.empty", needs: ["drive"], argv: (c) => ["drive", "set", c.drive, "description="], expect: "receipt", note: "empty clears it, which is the field's documented way of removing one" },
  // Only the FIRST `=` separates, the same as workspace set.
  { group: "drive", id: "drive.set.value-containing-equals", needs: ["drive"], argv: (c) => ["drive", "set", c.drive, "description=a=b=c"], expect: "receipt" },
  { group: "drive", id: "drive.set.value-containing-equals.readback", needs: ["drive"], argv: (c) => ["drive", "get", c.drive], expect: "receipt", match: ["description : a=b=c"] },
  { group: "drive", id: "drive.set.after-dashdash", needs: ["drive"], argv: (c) => ["drive", "set", c.drive, "--", "description=after the terminator"], expect: "receipt" },
  { group: "drive", id: "drive.set.both-fields", needs: ["drive"], argv: (c) => ["drive", "set", c.drive, `name=${DRIVE_NAME}`, "description=Both fields in one call."], expect: "receipt" },
  { group: "drive", id: "drive.set.readback", needs: ["drive"], argv: (c) => ["drive", "get", c.drive], expect: "receipt", match: [`name : ${DRIVE_NAME}`, "description : Both fields in one call."] },
  // Every bound the field list claims is the app's, so each has to come back a refusal rather than a
  // receipt — a documented rule nothing enforces is worse than no rule, because it reads as enforced.
  { group: "drive", id: "drive.set.reject.unknown-field", needs: ["drive"], argv: (c) => ["drive", "set", c.drive, "bogusField=1"], expect: "error" },
  { group: "drive", id: "drive.set.reject.name-empty", needs: ["drive"], argv: (c) => ["drive", "set", c.drive, "name="], expect: "error" },
  { group: "drive", id: "drive.set.reject.name-too-long", needs: ["drive"], argv: (c) => ["drive", "set", c.drive, `name=${"x".repeat(101)}`], expect: "error" },
  { group: "drive", id: "drive.set.reject.name-path-separator", needs: ["drive"], argv: (c) => ["drive", "set", c.drive, "name=shared/assets"], expect: "error", note: "a drive is addressed by name, and a name with a separator in it is a path" },
  { group: "drive", id: "drive.set.reject.name-leading-dot", needs: ["drive"], argv: (c) => ["drive", "set", c.drive, "name=.hidden"], expect: "error" },
  { group: "drive", id: "drive.set.reject.duplicate-name", needs: ["drive", "drive2"], argv: (c) => ["drive", "set", c.drive, `name=${DRIVE2_NAME}`], expect: "error", note: "the uniqueness rule holds for a rename, not only for a create" },
  { group: "drive", id: "drive.set.reject.left-state-alone", needs: ["drive"], argv: (c) => ["drive", "get", c.drive], expect: "receipt", match: [`name : ${DRIVE_NAME}`, "description : Both fields in one call."] },

  // ---- drivefiles: the same five verbs, mounted under the other noun ----
  // What is checked here is what mounting could break — the routes, the noun in the receipt, and the
  // separation of the two spaces. The path spellings, windows and archive guards are the same code and
  // are covered once, above, in `files`.
  //
  // A new drive is empty where a new workspace is not: a workspace ships with AGENTS.md and .skills/,
  // and a drive ships with nothing at all. It is the one listing in the suite that starts at zero.
  { group: "drivefiles", id: "drivefile.ls.new-drive-is-empty", needs: ["drive"], argv: (c) => ["drive", "file", "ls", c.drive], expect: "receipt", match: ["entries : (none)"], notMatch: ["AGENTS.md"] },
  { group: "drivefiles", id: "drivefile.put.file", needs: ["drive"], timeoutMs: TRANSFER_TIMEOUT, argv: (c) => ["drive", "file", "put", c.drive, "sample.txt"], expect: "receipt", match: ["destination : drive", "created : sample.txt", "overwritten : (none)"], notMatch: ["destination : workspace"] },
  { group: "drivefiles", id: "drivefile.put.file.same-again", needs: ["drive"], timeoutMs: TRANSFER_TIMEOUT, argv: (c) => ["drive", "file", "put", c.drive, "sample.txt"], expect: "receipt", match: ["overwritten : sample.txt", "created : (none)"] },
  { group: "drivefiles", id: "drivefile.put.dir", needs: ["drive"], timeoutMs: TRANSFER_TIMEOUT, argv: (c) => ["drive", "file", "put", c.drive, "tree"], expect: "receipt", match: ["tree/nested/deep/c.txt"] },
  { group: "drivefiles", id: "drivefile.put.explicit-dest", needs: ["drive"], timeoutMs: TRANSFER_TIMEOUT, argv: (c) => ["drive", "file", "put", c.drive, "sample.txt", "notes/copy.txt"], expect: "receipt", match: ["created : notes/copy.txt"] },
  { group: "drivefiles", id: "drivefile.ls.root", needs: ["drive"], argv: (c) => ["drive", "file", "ls", c.drive], expect: "receipt", match: ["sample.txt", "tree/", "lines :"] },
  { group: "drivefiles", id: "drivefile.ls.subdir", needs: ["drive"], argv: (c) => ["drive", "file", "ls", c.drive, "tree"], expect: "receipt", match: ["tree/nested/", "tree/a.txt"], notMatch: ["tree/nested/deep"] },
  { group: "drivefiles", id: "drivefile.ls.missing-path", needs: ["drive"], argv: (c) => ["drive", "file", "ls", c.drive, "no/such/dir"], expect: "error" },
  { group: "drivefiles", id: "drivefile.cat.whole", needs: ["drive"], argv: (c) => ["drive", "file", "cat", c.drive, "sample.txt"], expect: "ok", match: ["line 1", "line 10"] },
  { group: "drivefiles", id: "drivefile.cat.window", needs: ["drive"], argv: (c) => ["drive", "file", "cat", c.drive, "sample.txt", "--offset", "3", "--limit", "2"], expect: "ok", match: ["line 4", "line 5"], notMatch: ["line 7"] },
  { group: "drivefiles", id: "drivefile.cat.nested", needs: ["drive"], argv: (c) => ["drive", "file", "cat", c.drive, "tree/nested/deep/c.txt"], expect: "ok", match: ["tree nested deep c"] },
  { group: "drivefiles", id: "drivefile.cat.reject.missing", needs: ["drive"], argv: (c) => ["drive", "file", "cat", c.drive, "no/such/file.txt"], expect: "error" },
  { group: "drivefiles", id: "drivefile.put.binary", needs: ["drive"], timeoutMs: TRANSFER_TIMEOUT, argv: (c) => ["drive", "file", "put", c.drive, "blob.bin"], expect: "receipt", match: ["created : blob.bin"] },
  // The refusal names the noun it was reached through, so the fix it suggests is a command that exists.
  // Under the wrong noun it would send a caller to `paodo workspace file get` for a file in a drive.
  { group: "drivefiles", id: "drivefile.cat.reject.binary", needs: ["drive"], argv: (c) => ["drive", "file", "cat", c.drive, "blob.bin"], expect: "error", code: "CLI_NOT_TEXT_FILE", match: ["not a text file", "paodo drive file get"], notMatch: ["paodo workspace file get"] },
  { group: "drivefiles", id: "drivefile.get.file", needs: ["drive"], timeoutMs: TRANSFER_TIMEOUT, argv: (c) => ["drive", "file", "get", c.drive, "sample.txt", "pulled-drive/sample.txt"], expect: "receipt", match: ["destination : local"], localCheck: () => (fs.readFileSync(path.join(TMP, "pulled-drive/sample.txt"), "utf8").includes("line 7") ? [] : ["the file pulled from the drive does not have the content that was pushed"]) },
  { group: "drivefiles", id: "drivefile.get.dir", needs: ["drive"], timeoutMs: TRANSFER_TIMEOUT, argv: (c) => ["drive", "file", "get", c.drive, "tree", "pulled-drive/tree"], expect: "receipt", localCheck: () => (fs.existsSync(path.join(TMP, "pulled-drive/tree/nested/deep/c.txt")) ? [] : ["a directory pull from a drive did not recreate the whole subtree"]) },

  // The two spaces are separate storage, and the only thing saying which one a command addresses is the
  // word the caller typed. So: a file written to one is not readable from the other, and an id from one
  // is not an id in the other. Both are silent failures if they ever stop holding — a caller would be
  // reading or writing real files in the wrong place and getting an ok receipt for it.
  { group: "drivefiles", id: "isolation.put.marker-into-workspace", needs: ["ws"], timeoutMs: TRANSFER_TIMEOUT, argv: (c) => ["workspace", "file", "put", c.ws, "sample.txt", "ws-only.txt"], expect: "receipt", match: ["created : ws-only.txt"] },
  { group: "drivefiles", id: "isolation.put.marker-into-drive", needs: ["drive"], timeoutMs: TRANSFER_TIMEOUT, argv: (c) => ["drive", "file", "put", c.drive, "sample.txt", "drive-only.txt"], expect: "receipt", match: ["created : drive-only.txt"] },
  { group: "drivefiles", id: "isolation.workspace-reads-its-own", needs: ["ws"], argv: (c) => ["workspace", "file", "cat", c.ws, "ws-only.txt"], expect: "ok", match: ["line 1"] },
  { group: "drivefiles", id: "isolation.drive-reads-its-own", needs: ["drive"], argv: (c) => ["drive", "file", "cat", c.drive, "drive-only.txt"], expect: "ok", match: ["line 1"] },
  { group: "drivefiles", id: "isolation.workspace-cannot-read-the-drive", needs: ["ws"], argv: (c) => ["workspace", "file", "cat", c.ws, "drive-only.txt"], expect: "error" },
  { group: "drivefiles", id: "isolation.drive-cannot-read-the-workspace", needs: ["drive"], argv: (c) => ["drive", "file", "cat", c.drive, "ws-only.txt"], expect: "error" },
  // Both ids are random UUIDs, so nothing about the id itself says which space it belongs to — the
  // command word is the whole of it, and each collection has to refuse the other's id.
  { group: "drivefiles", id: "isolation.drive-file-ls-with-a-workspace-id", needs: ["ws"], argv: (c) => ["drive", "file", "ls", c.ws], expect: "error" },
  { group: "drivefiles", id: "isolation.workspace-file-ls-with-a-drive-id", needs: ["drive"], argv: (c) => ["workspace", "file", "ls", c.drive], expect: "error" },
  { group: "drivefiles", id: "isolation.drive-get-with-a-workspace-id", needs: ["ws"], argv: (c) => ["drive", "get", c.ws], expect: "error" },
  { group: "drivefiles", id: "isolation.workspace-get-with-a-drive-id", needs: ["drive"], argv: (c) => ["workspace", "get", c.drive], expect: "error" },

  { group: "drivefiles", id: "drivefile.rm.file", needs: ["drive"], argv: (c) => ["drive", "file", "rm", c.drive, "notes/copy.txt"], expect: "receipt", match: ["removed : notes/copy.txt", "removedCount : 1"] },
  { group: "drivefiles", id: "drivefile.rm.dir.trailing-slash", needs: ["drive"], argv: (c) => ["drive", "file", "rm", c.drive, "tree/nested/"], expect: "receipt", match: ["tree/nested/deep/c.txt"] },
  { group: "drivefiles", id: "drivefile.rm.reject.missing", needs: ["drive"], argv: (c) => ["drive", "file", "rm", c.drive, "no/such/file.txt"], expect: "error" },
  // Emptying a drive is the same client-side loop as emptying a workspace, over a root that this suite
  // filled itself. Nothing here is recoverable, which is why it is only ever run against our own drive.
  { group: "drivefiles", id: "drivefile.rm.root", needs: ["drive"], timeoutMs: TRANSFER_TIMEOUT, argv: (c) => ["drive", "file", "rm", c.drive, "/"], expect: "receipt", notMatch: ["removedCount : 0"] },
  { group: "drivefiles", id: "drivefile.rm.root.already-empty", needs: ["drive"], argv: (c) => ["drive", "file", "rm", c.drive, ""], expect: "receipt", match: ["removed : (none)", "removedCount : 0"] },
  { group: "drivefiles", id: "drivefile.ls.after-empty", needs: ["drive"], argv: (c) => ["drive", "file", "ls", c.drive], expect: "receipt", match: ["entries : (none)"] },

  // ---- connections: both graphs, from one command ----
  {
    group: "connection",
    id: "connection.create.link",
    needs: ["drive", "ws"],
    argv: (c) => ["connection", "create", c.drive, c.ws],
    expect: "receipt",
    // Which kind was made is read back rather than declared, so the receipt has to name both ends in
    // the drive-link vocabulary — not the caller/callee one an agent edge gets.
    match: ["connectionId", "drive :", "workspace :", DRIVE_NAME, WS_NAME],
    notMatch: ["caller :", "callee :"],
    capture(out, ctx) {
      ctx.link = /^connectionId\s*:\s*(\S+)$/im.exec(out)?.[1];
    },
  },
  // A drive link has no direction, so the other order is the same link — and connecting an
  // already-connected pair answers with the id it already has rather than making a second one beside
  // it. Both halves of that are one assertion: the same id back, from the reversed call.
  { group: "connection", id: "connection.create.link.idempotent-and-undirected", needs: ["link", "drive", "ws"], argv: (c) => ["connection", "create", c.ws, c.drive], expect: "receipt", match: (c) => [`connectionId : ${c.link}`] },
  { group: "connection", id: "connection.ls.all.names-the-link", needs: ["link"], argv: ["connection", "ls"], expect: "receipt", match: (c) => ["driveLinks", c.link, DRIVE_NAME] },
  // Given a workspace, its drives, callers and callees, each naming only the far end.
  { group: "connection", id: "connection.ls.for-workspace", needs: ["link", "ws"], argv: (c) => ["connection", "ls", c.ws], expect: "receipt", match: (c) => ["drives", "callers", "callees", DRIVE_NAME, c.link] },
  // Given a drive, the workspaces on it — and a drive has no agent calls, so those fields are absent.
  { group: "connection", id: "connection.ls.for-drive", needs: ["link", "drive"], argv: (c) => ["connection", "ls", c.drive], expect: "receipt", match: (c) => ["workspaces", WS_NAME, c.link], notMatch: ["callers", "callees"] },
  // The counts in `workspace get`/`drive get` and the listing here are two answers to one question, and
  // a link is only real if both of them see it.
  { group: "connection", id: "connection.counted.by-workspace-get", needs: ["link", "ws"], argv: (c) => ["workspace", "get", c.ws], expect: "receipt", match: ["connections"], notMatch: ["drives : 0"] },
  { group: "connection", id: "connection.counted.by-drive-get", needs: ["link", "drive"], argv: (c) => ["drive", "get", c.drive], expect: "receipt", match: ["connections"], notMatch: ["workspaces : 0"] },
  // A link joins a drive to a workspace, so two drives is not a connection of either kind. Refused
  // after both ids are looked up — which is what makes this an app-facing case rather than a local one.
  { group: "connection", id: "connection.create.reject.two-drives", needs: ["drive", "drive2"], argv: (c) => ["connection", "create", c.drive, c.drive2], expect: "error", code: "INVALID_REQUEST", match: ["two drives cannot be connected"] },
  {
    group: "connection",
    id: "connection.create.call",
    needs: ["ws", "ws2"],
    argv: (c) => ["connection", "create", c.ws, c.ws2],
    expect: "receipt",
    match: ["connectionId", "caller :", "callee :", WS_NAME, WS2_NAME],
    notMatch: ["drive :"],
    capture(out, ctx) {
      ctx.call = /^connectionId\s*:\s*(\S+)$/im.exec(out)?.[1];
    },
  },
  { group: "connection", id: "connection.create.call.idempotent", needs: ["call", "ws", "ws2"], argv: (c) => ["connection", "create", c.ws, c.ws2], expect: "receipt", match: (c) => [`connectionId : ${c.call}`] },
  // The one grant in this CLI that is directed, so the reverse edge is a different thing entirely — and
  // one the app refuses, because it would make the graph cyclic: a workspace reachable from its own
  // callee could be delegated to by the agent it delegates to.
  { group: "connection", id: "connection.create.call.reject.cycle", needs: ["call", "ws", "ws2"], argv: (c) => ["connection", "create", c.ws2, c.ws], expect: "error", note: "the reverse of an existing call would close a cycle" },
  // The near end is the subject and only the far end is printed, so the caller's own listing names its
  // callee and the callee's names its caller. Reading one from the wrong side is how a direction gets
  // misread, and the direction is the whole meaning of an agent edge.
  { group: "connection", id: "connection.ls.caller-side", needs: ["call", "ws"], argv: (c) => ["connection", "ls", c.ws], expect: "receipt", match: (c) => ["callees", WS2_NAME, c.call] },
  { group: "connection", id: "connection.ls.callee-side", needs: ["call", "ws2"], argv: (c) => ["connection", "ls", c.ws2], expect: "receipt", match: (c) => ["callers", WS_NAME, c.call] },
  { group: "connection", id: "connection.rm.call", needs: ["call"], argv: (c) => ["connection", "rm", c.call], expect: "receipt", match: ["deleted : true"] },
  { group: "connection", id: "connection.rm.call.again", needs: ["call"], argv: (c) => ["connection", "rm", c.call], expect: "receipt", match: ["deleted : false"], note: "the second run is the same answer as an id that was never there" },
  { group: "connection", id: "connection.ls.caller-side.after-rm", needs: ["call", "ws"], argv: (c) => ["connection", "ls", c.ws], expect: "receipt", match: ["callees : (none)"] },
  { group: "connection", id: "connection.rm.link", needs: ["link"], argv: (c) => ["connection", "rm", c.link], expect: "receipt", match: ["deleted : true"] },
  { group: "connection", id: "connection.rm.link.again", needs: ["link"], argv: (c) => ["connection", "rm", c.link], expect: "receipt", match: ["deleted : false"] },
  // Removing a link takes away one workspace's reach into the drive — not the drive, and not its files.
  { group: "connection", id: "connection.rm.link.left-the-drive-alone", needs: ["link", "drive"], argv: (c) => ["drive", "get", c.drive], expect: "receipt", match: [`name : ${DRIVE_NAME}`] },
  { group: "connection", id: "connection.ls.for-workspace.after-rm", needs: ["link", "ws"], argv: (c) => ["connection", "ls", c.ws], expect: "receipt", match: ["drives : (none)"] },

  // ---- keys: the three verbs, in the order that makes each one's refusal observable ----
  { group: "keys", id: "key.rotate.api.before-generate", needs: ["ws"], argv: (c) => ["workspace", "key", "rotate", c.ws, "api"], expect: "error", note: "rotate refuses to invent a missing secret" },
  { group: "keys", id: "key.revoke.api.before-generate", needs: ["ws"], argv: (c) => ["workspace", "key", "revoke", c.ws, "api"], expect: "error", note: "nothing to destroy" },
  // The plaintext itself, and not just the boolean beside it. `workspaceApiHasKey : true` is a fact
  // about the workspace; the secret is the thing this command exists to hand over, and it is readable
  // exactly once (help.mjs). A receipt that reported the key was minted and did not print it would
  // satisfy every hasKey assertion here and leave the caller with a live channel and no credential —
  // and nothing later in this run would notice, because the CLI never uses either secret itself.
  // The value is `«redacted»` by the time it reaches report.json; assertions read the raw output.
  { group: "keys", id: "key.generate.api", needs: ["ws"], argv: (c) => ["workspace", "key", "generate", c.ws, "api"], expect: "receipt", match: ["workspaceApiHasKey : true", "workspaceApiKey :"], notMatch: ["workspaceApiKey : (none)"] },
  { group: "keys", id: "key.generate.api.again", needs: ["ws"], argv: (c) => ["workspace", "key", "generate", c.ws, "api"], expect: "error", note: "generate refuses to overwrite an existing secret" },
  { group: "keys", id: "key.rotate.api", needs: ["ws"], argv: (c) => ["workspace", "key", "rotate", c.ws, "api"], expect: "receipt", match: ["workspaceApiHasKey : true", "workspaceApiKey :"], notMatch: ["workspaceApiKey : (none)"] },
  // The other direction, and the one that would be a leak rather than an omission: a read of the
  // workspace is not a place a secret may appear, however many times the channel fields do.
  { group: "keys", id: "key.api.not-readable-again", needs: ["ws"], argv: (c) => ["workspace", "get", c.ws], expect: "receipt", match: ["workspaceApiHasKey : true"], notMatch: ["workspaceApiKey :"], note: "readable exactly once means the receipt, not the resource" },
  // One channel's verb must not touch the other's secret.
  { group: "keys", id: "key.api.did-not-touch-mcp", needs: ["ws"], argv: (c) => ["workspace", "get", c.ws], expect: "receipt", match: ["workspaceApiHasKey : true", "workspaceMcpHasKey : false"] },
  // help.mjs's stated order: key first, then open the channel, so it is never live while the key travels.
  { group: "keys", id: "key.api.open-channel", needs: ["ws"], argv: (c) => ["workspace", "set", c.ws, "workspaceApiAccess=true"], expect: "receipt" },
  { group: "keys", id: "key.api.channel-reported", needs: ["ws"], argv: (c) => ["workspace", "get", c.ws], expect: "receipt", match: ["workspaceApiAccess : true", "workspaceApiHasKey : true"] },
  { group: "keys", id: "key.api.close-channel", needs: ["ws"], argv: (c) => ["workspace", "set", c.ws, "workspaceApiAccess=false"], expect: "receipt" },
  // A revocation has no plaintext to report — destroying a secret is the one key verb that mints
  // nothing, so a key field here would be the old secret surfacing on its way out.
  { group: "keys", id: "key.revoke.api", needs: ["ws"], argv: (c) => ["workspace", "key", "revoke", c.ws, "api"], expect: "receipt", match: ["workspaceApiHasKey : false"], notMatch: ["workspaceApiKey :"] },
  { group: "keys", id: "key.revoke.api.again", needs: ["ws"], argv: (c) => ["workspace", "key", "revoke", c.ws, "api"], expect: "error" },
  // Revoking destroys the secret and leaves the channel's switch alone — a channel open with no key is
  // a thing to go and fix, not a thing the receipt should hide.
  { group: "keys", id: "key.revoke.leaves-access-alone", needs: ["ws"], argv: (c) => ["workspace", "set", c.ws, "workspaceApiAccess=true"], expect: "receipt" },
  { group: "keys", id: "key.revoke.open-but-keyless", needs: ["ws"], argv: (c) => ["workspace", "get", c.ws], expect: "receipt", match: ["workspaceApiAccess : true", "workspaceApiHasKey : false"] },
  { group: "keys", id: "key.revoke.reclose", needs: ["ws"], argv: (c) => ["workspace", "set", c.ws, "workspaceApiAccess=false"], expect: "receipt" },
  { group: "keys", id: "key.rotate.mcp.before-generate", needs: ["ws"], argv: (c) => ["workspace", "key", "rotate", c.ws, "mcp"], expect: "error" },
  // The MCP channel mints its own secret under its own name, so the plaintext is asserted here too:
  // one channel relaying a key is not evidence the other does.
  { group: "keys", id: "key.generate.mcp", needs: ["ws"], argv: (c) => ["workspace", "key", "generate", c.ws, "mcp"], expect: "receipt", match: ["workspaceMcpHasKey : true", "workspaceMcpKey :"], notMatch: ["workspaceMcpKey : (none)"] },
  { group: "keys", id: "key.generate.mcp.again", needs: ["ws"], argv: (c) => ["workspace", "key", "generate", c.ws, "mcp"], expect: "error" },
  { group: "keys", id: "key.rotate.mcp", needs: ["ws"], argv: (c) => ["workspace", "key", "rotate", c.ws, "mcp"], expect: "receipt", match: ["workspaceMcpHasKey : true", "workspaceMcpKey :"], notMatch: ["workspaceMcpKey : (none)"] },
  { group: "keys", id: "key.mcp.open-channel", needs: ["ws"], argv: (c) => ["workspace", "set", c.ws, "workspaceMcpAccess=true"], expect: "receipt" },
  { group: "keys", id: "key.mcp.channel-reported", needs: ["ws"], argv: (c) => ["workspace", "get", c.ws], expect: "receipt", match: ["workspaceMcpAccess : true", "workspaceMcpHasKey : true"] },
  { group: "keys", id: "key.mcp.close-channel", needs: ["ws"], argv: (c) => ["workspace", "set", c.ws, "workspaceMcpAccess=false"], expect: "receipt" },
  { group: "keys", id: "key.revoke.mcp", needs: ["ws"], argv: (c) => ["workspace", "key", "revoke", c.ws, "mcp"], expect: "receipt", match: ["workspaceMcpHasKey : false"], notMatch: ["workspaceMcpKey :"] },
  { group: "keys", id: "key.generate.missing-workspace", argv: ["workspace", "key", "generate", MISSING_ID, "api"], expect: "error" },
  { group: "keys", id: "key.revoke.missing-workspace", argv: ["workspace", "key", "revoke", MISSING_ID, "mcp"], expect: "error" },
  // A drive has no agent to call and no channel to open, so the key verbs are the workspace's alone —
  // and a drive id in one of them is refused rather than minting a secret against a drive.
  { group: "keys", id: "key.generate.with-a-drive-id", needs: ["drive"], argv: (c) => ["workspace", "key", "generate", c.drive, "api"], expect: "error" },

  // ---- teardown: the deletes, and that each id really is gone ----
  {
    group: "teardown",
    id: "workspace.rm",
    needs: ["ws"],
    argv: (c) => ["workspace", "rm", c.ws],
    expect: "receipt",
    match: ["workspaceId"],
    // `deleted: true` is deliberately not relayed: `ok` already says it worked.
    notMatch: ["deleted"],
    capture(_out, ctx) {
      ctx.removedWs = ctx.ws;
    },
  },
  { group: "teardown", id: "workspace.get.after-rm", needs: ["removedWs"], argv: (c) => ["workspace", "get", c.removedWs], expect: "error" },
  { group: "teardown", id: "workspace.rm.after-rm", needs: ["removedWs"], argv: (c) => ["workspace", "rm", c.removedWs], expect: "error" },
  { group: "teardown", id: "file.ls.after-rm", needs: ["removedWs"], argv: (c) => ["workspace", "file", "ls", c.removedWs], expect: "error" },
  {
    group: "teardown",
    id: "workspace.rm.callee",
    needs: ["ws2"],
    argv: (c) => ["workspace", "rm", c.ws2],
    expect: "receipt",
    capture(_out, ctx) {
      ctx.removedWs2 = ctx.ws2;
    },
  },
  { group: "teardown", id: "workspace.ls.no-longer-listed", needs: ["removedWs"], argv: ["workspace", "ls"], expect: "receipt", notMatch: [WS_NAME, WS2_NAME] },
  {
    group: "teardown",
    id: "drive.rm",
    needs: ["drive"],
    argv: (c) => ["drive", "rm", c.drive],
    expect: "receipt",
    match: ["driveId"],
    notMatch: ["deleted"],
    capture(_out, ctx) {
      ctx.removedDrive = ctx.drive;
    },
  },
  { group: "teardown", id: "drive.get.after-rm", needs: ["removedDrive"], argv: (c) => ["drive", "get", c.removedDrive], expect: "error" },
  { group: "teardown", id: "drive.rm.after-rm", needs: ["removedDrive"], argv: (c) => ["drive", "rm", c.removedDrive], expect: "error" },
  { group: "teardown", id: "drive.file.ls.after-rm", needs: ["removedDrive"], argv: (c) => ["drive", "file", "ls", c.removedDrive], expect: "error" },
  // A deleted drive takes its connections with it, so nothing in the graph may still name it. This is
  // the check that a delete is not leaving dangling links behind for someone else to find.
  { group: "teardown", id: "connection.ls.after-drive-rm", needs: ["removedDrive"], argv: ["connection", "ls"], expect: "receipt", notMatch: (c) => [c.removedDrive] },
  {
    group: "teardown",
    id: "drive.rm.second",
    needs: ["drive2"],
    argv: (c) => ["drive", "rm", c.drive2],
    expect: "receipt",
    capture(_out, ctx) {
      ctx.removedDrive2 = ctx.drive2;
    },
  },
  { group: "teardown", id: "drive.ls.no-longer-listed", needs: ["removedDrive"], argv: ["drive", "ls"], expect: "receipt", notMatch: [DRIVE_NAME, DRIVE2_NAME] },
];

// `--only` names groups, but the lifecycle groups are a chain: `files` without the create that precedes
// it is a run of skips, and — worse — a run that could create nothing and therefore clean nothing up.
// Selecting any group scoped to a workspace or a drive pulls in the creates it needs, the app reads its
// model values come from, and the teardown that deletes all of it.
const LIFECYCLE_GROUPS = ["workspace", "files", "drive", "drivefiles", "connection", "keys", "teardown"];

function resolveSelection() {
  const asked = flags
    .find((flag) => flag.startsWith("--only="))
    ?.slice("--only=".length)
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  if (OFFLINE) return new Set(OFFLINE_GROUPS);
  if (!asked) return null;
  const selection = new Set(asked);
  if (LIFECYCLE_GROUPS.some((group) => selection.has(group))) {
    selection.add("app").add("workspace").add("teardown");
  }
  // The drive is created in the `drive` group, so anything that addresses one needs that group too —
  // and `connection` needs both sides of every edge it makes.
  if (["drivefiles", "connection"].some((group) => selection.has(group))) selection.add("drive");
  return selection;
}

const ONLY = resolveSelection();
const selectedCases = () => CASES.filter((testCase) => !ONLY || ONLY.has(testCase.group));

// ---------------------------------------------------------------------------- the runner

/** A case field that may be written as a function of the captured context. */
function resolve(value, context) {
  return typeof value === "function" ? value(context) : value;
}

function invoke(args, { timeoutMs = 30_000, env } = {}) {
  const started = process.hrtime.bigint();
  return new Promise((resolve) => {
    execFile(
      BIN.file,
      [...BIN.prefix, ...args],
      {
        cwd: TMP,
        encoding: "utf8",
        timeout: timeoutMs,
        maxBuffer: 32 * 1024 * 1024,
        // Merged onto this process's environment rather than replacing it, so PATH still resolves the
        // binary and only the variables a case is about are the ones it changes.
        env: env ? { ...process.env, ...env } : process.env,
      },
      (error, stdout, stderr) => {
        const numericExit = error && typeof error.code === "number" ? error.code : null;
        resolve({
          exitCode: error ? numericExit : 0,
          signal: error?.signal ?? null,
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          spawnError: error && numericExit === null && !error.signal ? String(error.message) : null,
          durationMs: Number(process.hrtime.bigint() - started) / 1e6,
        });
      },
    );
  });
}

function infraCodeIn(output) {
  return INFRA_CODES.find((code) => output.includes(`code : ${code}`));
}

/**
 * What the case asked for versus what came back — every reason, not just the first.
 *
 * `match`/`notMatch` arrive already resolved against the context, since some of them are ids only an
 * earlier case knows: "the second create answered with the id the first one did" is one assertion, and
 * it cannot be written as a constant.
 *
 * The infrastructure check is the one that is not obvious: a case expecting a refusal is satisfied by
 * `exit 1` plus `ok : false`, and a timed-out request is exactly that. Without this, an app that had
 * stopped answering would report as a suite full of passing refusals.
 */
/**
 * Output with every JSON-quoted string the CLI printed decoded back to its text. A result's strings are
 * quoted on the way out (output.mjs `formatResult`), and the cases below are written against the text.
 */
function plain(output) {
  return output.replace(/"(?:[^"\\\n]|\\.)*"/g, (quoted) => {
    try {
      return JSON.parse(quoted);
    } catch {
      return quoted;
    }
  });
}

function judge(testCase, run) {
  // Both spellings, so a case may assert on the text of a value or on exactly what was printed.
  const printed = `${run.stdout}\n${run.stderr}`;
  const output = `${printed}\n${plain(printed)}`;
  const reasons = [];
  if (run.spawnError) reasons.push(`could not run the CLI: ${run.spawnError}`);
  if (run.signal) reasons.push(`killed by ${run.signal} after ${Math.round(run.durationMs)}ms — treated as a timeout`);

  const infra = infraCodeIn(output);
  if (infra && infra !== testCase.code) {
    reasons.push(`infrastructure failure (${infra}), not the behaviour under test`);
  }

  if (testCase.expect === "error") {
    if (run.exitCode !== 1) reasons.push(`expected exit 1, got ${run.exitCode}`);
    if (!output.includes("ok : false")) reasons.push("expected an `ok : false` failure envelope");
    if (testCase.code && !output.includes(`code : ${testCase.code}`)) reasons.push(`expected code : ${testCase.code}`);
  } else {
    if (run.exitCode !== 0) reasons.push(`expected exit 0, got ${run.exitCode}`);
    if (output.includes("ok : false")) reasons.push("command reported a failure envelope");
    if (testCase.expect === "receipt" && !output.includes("ok : true")) reasons.push("expected an `ok : true` receipt");
  }

  for (const needle of testCase.match ?? []) {
    if (!output.includes(needle)) reasons.push(`output is missing ${JSON.stringify(needle)}`);
  }
  for (const needle of testCase.notMatch ?? []) {
    if (output.includes(needle)) reasons.push(`output unexpectedly contains ${JSON.stringify(needle)}`);
  }
  // What the command did to this machine, which no amount of reading its output can show.
  if (testCase.localCheck) {
    try {
      reasons.push(...testCase.localCheck());
    } catch (error) {
      reasons.push(`local check threw: ${error.message}`);
    }
  }
  return { reasons, infra: infra ?? null };
}

function record(records, fields) {
  records.push(fields);
  return fields;
}

/**
 * The id/name pairs in a listing receipt, whatever order the two fields come in.
 *
 * output.mjs prints a run of consecutive scalar fields as one block and separates blocks with a blank
 * line, so one entry of `workspace ls` or `drive ls` is one block holding both. Read as blocks rather
 * than as an `id :` line with a `name :` line under it, because that pairing is the resource's field
 * order — a fact about the app's JSON, not about this format — and a suite that deletes things on a
 * name match must not be the thing that quietly stops matching.
 */
function idsByName(output) {
  const found = [];
  for (const block of output.split(/\n\s*\n/)) {
    const id = /^id\s*:\s*(\S+)$/im.exec(block)?.[1];
    const name = /^name\s*:[ \t]*(.*)$/im.exec(block)?.[1];
    if (id && name !== undefined) found.push({ id, name: name.trim() });
  }
  return found;
}

/**
 * Self-test workspaces and drives an earlier run left behind, because it died before its teardown.
 *
 * Reported, not deleted, unless `--sweep` says otherwise. Neither a workspace nor a drive is something
 * to remove on a name match while nobody is watching, even a name this suite chose — and a drive least
 * of all, since nothing in one is recoverable. The normal path never needs it, because the run below
 * deletes everything it created whether it finishes or fails.
 */
async function sweepLeftovers(records) {
  const stale = [];
  for (const [noun, listing, names] of [
    ["workspace", ["workspace", "ls"], SELFTEST_WORKSPACES],
    ["drive", ["drive", "ls"], SELFTEST_DRIVES],
  ]) {
    const run = await invoke(listing);
    if (run.exitCode !== 0) continue;
    for (const { id, name } of idsByName(plain(run.stdout))) {
      if (names.has(name)) stale.push({ noun, id, name });
    }
  }
  if (stale.length === 0) return;

  const describe = ({ noun, id }) => `${noun} ${id}`;
  if (!SWEEP) {
    record(records, {
      id: "sweep.leftovers",
      group: "sweep",
      command: null,
      note: `${stale.length} self-test resource(s) from an earlier run were left in place — rerun with --sweep to delete them`,
      expect: "n/a",
      verdict: "skipped",
      reasons: [`not deleting ${stale.map(describe).join(", ")} without --sweep`],
    });
    console.log(`NOTE  ${stale.length} leftover self-test resource(s) left in place (pass --sweep to delete)`);
    return;
  }

  for (const leftover of stale) {
    const args = [leftover.noun, "rm", leftover.id];
    const run = await invoke(args);
    const ok = run.exitCode === 0;
    record(records, {
      id: `sweep.${leftover.noun}.${leftover.id}`,
      group: "sweep",
      command: shellish(args),
      note: `leftover self-test ${leftover.noun} from an earlier run`,
      expect: "receipt",
      verdict: ok ? "passed" : "failed",
      exitCode: run.exitCode,
      durationMs: Math.round(run.durationMs),
      reasons: ok ? [] : [`could not delete a leftover self-test ${leftover.noun}`],
      stdout: clip(redact(run.stdout)).text,
      stderr: clip(redact(run.stderr)).text,
    });
    console.log(`${ok ? "SWEEP" : "FAIL "} ${shellish(args)}`);
  }
}

/** What each case would run, with no process spawned and nothing sent. */
function dryRun() {
  const placeholders = new Proxy(Object.create(null), {
    get: (_t, key) => {
      if (key === "ws" || key === "ws2" || key === "removedWs" || key === "removedWs2") return WS_PLACEHOLDER;
      if (key === "drive" || key === "drive2" || key === "removedDrive" || key === "removedDrive2") return DRIVE_PLACEHOLDER;
      if (key === "stub") return STUB_PLACEHOLDER;
      if (key === "closedPort") return "<closed-port>";
      return `<${String(key)}>`;
    },
  });
  let app = 0;
  let offline = 0;
  for (const testCase of selectedCases()) {
    const args = resolve(testCase.argv, placeholders);
    const env = resolve(testCase.env, placeholders);
    const facing = APP_FACING.has(testCase.group);
    if (facing) app += 1;
    else offline += 1;
    console.log(`${facing ? "app  " : "off  "} ${testCase.group.padEnd(11)} ${testCase.expect.padEnd(7)} ${shellish(args)}${envSuffix(env)}`);
  }
  console.log(`\n${app + offline} cases: ${app} reach the app, ${offline} never do.`);
  console.log(`Of the ${offline}: help/dispatch/config send no request at all or aim at an unroutable host;`);
  console.log(`transport is answered by a stub HTTP server this process runs on 127.0.0.1.`);
  console.log(`Workspaces created: 2 (${WS_NAME}, ${WS2_NAME}), deleted at the end.`);
  console.log(`Drives created: 2 (${DRIVE_NAME}, ${DRIVE2_NAME}), deleted at the end.`);
  console.log(`Connections created: 2 (one drive link, one agent call), removed by the suite and again by the deletes.`);
  console.log(`Existing workspaces and drives: read only.`);
  console.log(`Agent invocations: 0 — the CLI has no command that starts one.`);
  console.log(`Leftover sweep: ${SWEEP ? "ON — will delete self-test workspaces and drives from earlier runs" : "off (report only)"}`);
  console.log(`\nNothing was run. Drop --dry-run to execute.`);
}

async function main() {
  if (DRY_RUN) {
    dryRun();
    return;
  }

  buildScratch();
  const startedAt = new Date();
  const context = Object.create(null);
  const records = [];
  let consecutiveInfra = 0;
  let aborted = null;
  let stub = null;

  const selected = selectedCases();
  const wantsStub = selected.some((testCase) => testCase.group === "transport");
  const wantsApp = selected.some((testCase) => APP_FACING.has(testCase.group));

  if (selected.some((testCase) => testCase.group === "config")) {
    context.closedPort = await reserveClosedPort();
  }
  if (wantsStub) {
    stub = await startStub();
    context.stub = stub.base;
    console.log(`stub app listening on ${stub.base}\n`);
  }

  try {
    if (wantsApp) {
      // One request, before the matrix. An app that is not answering gets the app-facing cases skipped
      // rather than attempted — nothing here is worth adding load to an app that is already struggling.
      const preflight = await invoke(["app", "status"], { timeoutMs: 20_000 });
      const preflightOk = preflight.exitCode === 0 && preflight.stdout.includes("ok : true");
      record(records, {
        id: "preflight.app.status",
        group: "preflight",
        command: shellish(["app", "status"]),
        note: "gate: the app-facing groups run only if this passes",
        expect: "receipt",
        verdict: preflightOk ? "passed" : "failed",
        exitCode: preflight.exitCode,
        durationMs: Math.round(preflight.durationMs),
        reasons: preflightOk ? [] : ["the app did not answer, so every app-facing case was skipped"],
        stdout: clip(redact(preflight.stdout)).text,
        stderr: clip(redact(preflight.stderr)).text,
      });
      console.log(`${preflightOk ? "PASS" : "FAIL"}  preflight.app.status`);
      if (!preflightOk) {
        aborted = "the preflight app status check failed";
        console.log("      ↳ skipping every app-facing case; the offline groups still run\n");
      } else {
        await sweepLeftovers(records);
      }
    }

    // Anything this run created and has not yet deleted. Teardown is exempt from the abort for exactly
    // this set: a workspace or a drive that exists has to be deleted even when the run is being cut
    // short, and it is the one place where one more request is the responsible choice.
    const outstanding = () => OWNED.filter((owned) => context[owned.key] && context[owned.removedKey] === undefined);

    for (const testCase of selected) {
      const facing = APP_FACING.has(testCase.group);
      const skipForAbort = aborted && facing && !(testCase.group === "teardown" && outstanding().length > 0);
      const missing = (testCase.needs ?? []).filter((key) => context[key] === undefined);

      if (skipForAbort || missing.length > 0) {
        record(records, {
          id: testCase.id,
          group: testCase.group,
          command: null,
          expect: testCase.expect,
          verdict: "skipped",
          reasons: skipForAbort
            ? [`aborted: ${aborted}`]
            : [`needs ${missing.join(", ")} from an earlier case that did not produce it`],
          ...(testCase.note ? { note: testCase.note } : {}),
        });
        console.log(`SKIP  ${testCase.id}`);
        continue;
      }

      const args = resolve(testCase.argv, context);
      const env = resolve(testCase.env, context);
      const run = await invoke(args, { timeoutMs: testCase.timeoutMs, env });
      const { reasons, infra } = judge(
        { ...testCase, match: resolve(testCase.match, context), notMatch: resolve(testCase.notMatch, context) },
        run,
      );
      const verdict = reasons.length === 0 ? "passed" : "failed";
      if (verdict === "passed") testCase.capture?.(plain(run.stdout), context);

      if (facing) {
        consecutiveInfra = infra || run.signal ? consecutiveInfra + 1 : 0;
        if (consecutiveInfra >= BREAKER_LIMIT && !aborted) {
          aborted = `${consecutiveInfra} consecutive infrastructure failures — the app looks unhealthy`;
          console.log(`\n!!    circuit breaker: ${aborted}. Remaining app-facing cases will be skipped.\n`);
        }
      }

      const stdout = clip(redact(run.stdout));
      const stderr = clip(redact(run.stderr));
      record(records, {
        id: testCase.id,
        group: testCase.group,
        command: shellish(args),
        ...(env ? { env: Object.fromEntries(Object.entries(env).map(([k, v]) => [k, k === "PAODO_TOKEN" ? "«overridden»" : v])) } : {}),
        ...(testCase.note ? { note: testCase.note } : {}),
        appFacing: facing,
        expect: testCase.expect,
        ...(testCase.code ? { expectedCode: testCase.code } : {}),
        verdict,
        exitCode: run.exitCode,
        signal: run.signal,
        durationMs: Math.round(run.durationMs),
        reasons,
        stdout: stdout.text,
        stdoutTruncated: stdout.truncated,
        stderr: stderr.text,
        stderrTruncated: stderr.truncated,
      });
      console.log(`${verdict === "passed" ? "PASS" : "FAIL"}  ${testCase.id.padEnd(46)} ${shellish(args)}${envSuffix(env)}`);
      if (verdict === "failed") for (const reason of reasons) console.log(`        ↳ ${reason}`);
    }

    // Whatever the teardown cases did not reach. A workspace or a drive outlives a crashed or
    // cut-short run otherwise, and the next run's sweep is not a substitute for this suite cleaning up
    // after itself. Connections need no line here: deleting either end takes them with it.
    for (const owned of outstanding()) {
      const args = [owned.noun, "rm", context[owned.key]];
      const run = await invoke(args);
      const ok = run.exitCode === 0;
      if (ok) context[owned.removedKey] = context[owned.key];
      record(records, {
        id: `teardown.forced-rm.${owned.key}`,
        group: "teardown",
        command: shellish(args),
        note: "the suite did not reach its own teardown case",
        expect: "receipt",
        verdict: ok ? "passed" : "failed",
        exitCode: run.exitCode,
        durationMs: Math.round(run.durationMs),
        reasons: ok ? [] : [`the self-test ${owned.noun} ${context[owned.key]} could not be deleted — delete it by hand`],
        stdout: clip(redact(run.stdout)).text,
        stderr: clip(redact(run.stderr)).text,
      });
      console.log(`${ok ? "PASS" : "FAIL"}  teardown.forced-rm.${owned.key}`);
    }
  } finally {
    if (stub) await new Promise((resolve) => stub.server.close(resolve));
  }

  const finishedAt = new Date();
  const count = (verdict) => records.filter((r) => r.verdict === verdict).length;
  const byGroup = {};
  for (const entry of records) {
    const bucket = (byGroup[entry.group] ??= { total: 0, passed: 0, failed: 0, skipped: 0 });
    bucket.total += 1;
    bucket[entry.verdict] += 1;
  }

  const created = OWNED.filter((owned) => context[owned.key]);
  const leftover = created.filter((owned) => context[owned.removedKey] === undefined);
  const tally = (noun, list) => list.filter((owned) => owned.noun === noun).length;

  const report = {
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt - startedAt,
    cli: { invokedAs: BIN.how, binary: BIN.file, entry: BIN.prefix[0] ?? null, node: process.version },
    endpoint: ENV.endpoint ?? "(not configured)",
    stubEndpoint: context.stub ?? null,
    scratchDir: TMP,
    selection: ONLY ? [...ONLY] : "all groups",
    aborted,
    serverImpact: {
      requestsSentToApp: records.filter((r) => r.appFacing !== false && r.command && r.verdict !== "skipped").length,
      offlineCases: records.filter((r) => r.appFacing === false).length,
      workspacesCreated: tally("workspace", created),
      workspacesDeleted: tally("workspace", created) - tally("workspace", leftover),
      drivesCreated: tally("drive", created),
      drivesDeleted: tally("drive", created) - tally("drive", leftover),
      connectionsCreated: [context.link, context.call].filter(Boolean).length,
      leftoverResources: leftover.map((owned) => `${owned.noun} ${context[owned.key]}`),
      agentInvocations: 0,
      sweepEnabled: SWEEP,
    },
    owned: OWNED.map((owned) => ({
      noun: owned.noun,
      name: owned.name,
      id: context[owned.key] ?? null,
      deleted: context[owned.removedKey] !== undefined,
    })),
    summary: { total: records.length, passed: count("passed"), failed: count("failed"), skipped: count("skipped") },
    groups: byGroup,
    failures: records.filter((r) => r.verdict === "failed").map((r) => ({ id: r.id, command: r.command, reasons: r.reasons })),
    cases: records,
  };

  fs.writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`);
  if (!KEEP) fs.rmSync(TMP, { recursive: true, force: true });

  const { total, passed, failed, skipped } = report.summary;
  console.log(`\n${passed}/${total} passed, ${failed} failed, ${skipped} skipped in ${report.durationMs}ms`);
  for (const [group, tallyForGroup] of Object.entries(byGroup)) {
    const extra = [tallyForGroup.failed ? `${tallyForGroup.failed} failed` : null, tallyForGroup.skipped ? `${tallyForGroup.skipped} skipped` : null]
      .filter(Boolean)
      .join(", ");
    console.log(`  ${group.padEnd(11)} ${tallyForGroup.passed}/${tallyForGroup.total} passed${extra ? `, ${extra}` : ""}`);
  }
  for (const line of report.serverImpact.leftoverResources) {
    console.log(`\n!! ${line} was NOT deleted — remove it by hand.`);
  }
  console.log(`\nreport: ${REPORT}`);
  process.exitCode = failed === 0 ? 0 : 1;
}

await main();
