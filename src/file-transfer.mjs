// Local half of PAODO's private tar transfer format. Archives contain exactly one virtual
// `payload` root; callers map that root to the destination entry they chose.
//
// This walk sends everything it finds. It used to fetch the app's ignore contract and pre-filter
// against it, which meant a served contract, a validation of that served contract, a second exclusion
// list to merge into the receipt — and two definitions of what travels, one of them here. The app
// already applies the real one when the archive arrives and names
// what it dropped in the receipt, so the only thing the pre-filter bought was not uploading bytes that
// were going to be discarded. That is a bandwidth saving, not a rule, and it is not worth a copy of the
// rule living in this client. Pushing a directory with a node_modules in it now uploads it and has it
// refused on arrival.

import fs from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import tar from "tar-stream";
import { CliError, usageError } from "./errors.mjs";

const PAYLOAD = "payload";

async function collectDirectory(hostPath, relPath, items) {
  items.push({ type: "directory", relPath, hostPath });
  const entries = await fs.readdir(hostPath, { withFileTypes: true });
  for (const entry of entries) {
    const childRel = relPath ? path.posix.join(relPath, entry.name) : entry.name;
    const childHost = path.join(hostPath, entry.name);
    if (entry.isDirectory()) {
      await collectDirectory(childHost, childRel, items);
      continue;
    }
    if (!entry.isFile()) {
      throw new CliError("CLI_UNSUPPORTED_FILE", `${childHost} is not a regular file or directory.`);
    }
    const stat = await fs.stat(childHost);
    items.push({
      type: "file",
      relPath: childRel,
      hostPath: childHost,
      size: stat.size,
      executable: (stat.mode & 0o111) !== 0,
    });
  }
}

export async function collectLocalTransfer(source) {
  const hostPath = path.resolve(source);
  let stat;
  try {
    stat = await fs.lstat(hostPath);
  } catch (error) {
    if (error?.code === "ENOENT") throw usageError(`Source does not exist: ${source}`);
    throw error;
  }
  if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
    throw new CliError("CLI_UNSUPPORTED_FILE", `${source} is not a regular file or directory.`);
  }
  const items = [];
  if (stat.isFile()) {
    items.push({ type: "file", relPath: "", hostPath, size: stat.size, executable: (stat.mode & 0o111) !== 0 });
  } else {
    await collectDirectory(hostPath, "", items);
  }
  return { items, sourceType: stat.isFile() ? "file" : "directory", hostPath };
}

function tarName(relPath) {
  return relPath ? `${PAYLOAD}/${relPath}` : PAYLOAD;
}

export function packLocalTransfer(items) {
  const pack = tar.pack();
  void (async () => {
    try {
      for (const item of items) {
        if (item.type === "directory") {
          await new Promise((resolve, reject) => {
            pack.entry({ name: tarName(item.relPath), type: "directory", mode: 0o755 }, (error) =>
              error ? reject(error) : resolve(),
            );
          });
        } else {
          const target = pack.entry({
            name: tarName(item.relPath),
            type: "file",
            size: item.size,
            mode: item.executable ? 0o755 : 0o644,
          });
          await pipeline(createReadStream(item.hostPath), target);
        }
      }
      pack.finalize();
    } catch (error) {
      pack.destroy(error);
    }
  })();
  return pack;
}

function archivePath(name) {
  if (name.includes("\\") || name.includes("\0") || name.startsWith("/")) {
    throw new CliError("INVALID_RESPONSE", "PAODO returned an invalid transfer entry path.");
  }
  const normalized = path.posix.normalize(name).replace(/\/$/, "");
  if (normalized !== name.replace(/\/$/, "") || (normalized !== PAYLOAD && !normalized.startsWith(`${PAYLOAD}/`))) {
    throw new CliError("INVALID_RESPONSE", "PAODO returned a transfer entry outside payload.");
  }
  return normalized === PAYLOAD ? "" : normalized.slice(PAYLOAD.length + 1);
}

async function drain(stream) {
  stream.resume();
  await new Promise((resolve, reject) => {
    stream.once("end", resolve);
    stream.once("error", reject);
  });
}

async function extractResponse(response, stageDir) {
  if (!response.body) throw new CliError("INVALID_RESPONSE", "PAODO returned an empty transfer body.");
  const extract = tar.extract();
  const source = Readable.fromWeb(response.body);
  const items = [];
  const seen = new Set();
  let sourceType;
  const completed = new Promise((resolve, reject) => {
    // Reject from where the failure is known, rather than routing it through extract.destroy() and
    // waiting for an "error" event: mid-entry the extract is parked waiting for next(), and the event
    // does not arrive, so the rejection escaped as an uncaught exception instead of failing the pull.
    // Destroying afterwards is only to stop the source pumping into a stream nobody will read.
    const fail = (error) => {
      reject(error);
      extract.destroy();
      source.destroy();
    };
    extract.on("entry", (header, stream, next) => {
      void (async () => {
        const relPath = archivePath(header.name);
        if (seen.has(relPath)) throw new CliError("INVALID_RESPONSE", `PAODO returned duplicate entry ${header.name}.`);
        seen.add(relPath);
        if (header.type !== "file" && header.type !== "directory") {
          throw new CliError("INVALID_RESPONSE", `PAODO returned unsupported entry ${header.name}.`);
        }
        if (!relPath) sourceType = header.type;
        else if (sourceType !== "directory") {
          throw new CliError("INVALID_RESPONSE", "PAODO returned child entries under a file payload.");
        }
        const hostPath = relPath ? path.join(stageDir, PAYLOAD, relPath) : path.join(stageDir, PAYLOAD);
        if (header.type === "directory") {
          await fs.mkdir(hostPath, { recursive: true, mode: 0o755 });
          await drain(stream);
          items.push({ type: "directory", relPath, hostPath });
        } else {
          await fs.mkdir(path.dirname(hostPath), { recursive: true });
          const executable = ((header.mode ?? 0) & 0o111) !== 0;
          const mode = executable ? 0o755 : 0o644;
          await pipeline(stream, createWriteStream(hostPath, { flags: "wx", mode }));
          // Creation mode is filtered through the process umask, and the staged inode is renamed into
          // place rather than copied, so the mode has to be made exact here — after this there is no
          // later write to correct it.
          await fs.chmod(hostPath, mode);
          items.push({ type: "file", relPath, hostPath, executable });
        }
      })()
        .then(() => next())
        .catch(fail);
    });
    extract.once("finish", resolve);
    // `on`, not `once`: a torn-down pipe can surface the same failure more than once, and an emission
    // with no listener left becomes an uncaught exception. A settled promise ignores the repeats.
    extract.on("error", reject);
    source.on("error", reject);
  });
  source.pipe(extract);
  await completed;
  if (!sourceType || !seen.has("")) throw new CliError("INVALID_RESPONSE", "PAODO returned no payload entry.");
  return { sourceType, items };
}

async function existingType(target) {
  try {
    const stat = await fs.lstat(target);
    if (stat.isFile()) return "file";
    if (stat.isDirectory()) return "directory";
    return "unsupported";
  } catch (error) {
    if (error?.code === "ENOENT") return "missing";
    throw error;
  }
}

function targetFor(sourceType, dest, relPath) {
  if (sourceType === "file") return dest;
  return relPath ? path.join(dest, ...relPath.split("/")) : dest;
}

/**
 * The nearest existing ancestor of `target`. Staging there rather than in the system temp directory is
 * what makes the landing a rename: os.tmpdir() is routinely a different filesystem, and rename across
 * filesystems fails with EXDEV. This directory also has to exist and be writable for the pull to be
 * able to create its destination at all, so it is the safest same-filesystem choice available.
 */
async function nearestExistingAncestor(target) {
  let current = path.dirname(target);
  for (;;) {
    try {
      if ((await fs.stat(current)).isDirectory()) return current;
    } catch {
      // Keep walking up.
    }
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

/**
 * Merge a staged tree into an existing directory by renaming, deepest decision first.
 *
 * Two trees cannot be merged atomically on POSIX, so the guarantee here is per entry: anything that
 * appears is complete. A directory that already exists is descended into, because rename cannot
 * replace a non-empty directory; everything else is renamed, which for a file replaces the old inode
 * in one step rather than truncating and rewriting it.
 */
async function mergeInto(stagedDir, targetDir, receipt) {
  await fs.mkdir(targetDir, { recursive: true, mode: 0o755 });
  for (const entry of await fs.readdir(stagedDir, { withFileTypes: true })) {
    const from = path.join(stagedDir, entry.name);
    const to = path.join(targetDir, entry.name);
    const existing = await existingType(to);
    if (entry.isDirectory() && existing === "directory") {
      await mergeInto(from, to, receipt);
      continue;
    }
    await fs.rename(from, to);
    (existing === "missing" ? receipt.created : receipt.overwritten).push(to);
  }
}

/**
 * Unpack a transfer and land it in one step.
 *
 * The whole archive is staged and every destination conflict is checked before anything is moved, so a
 * pull either lands or leaves the destination untouched. Nothing appears at the destination while bytes
 * are still arriving — the earlier version copied each file into place as it was extracted, which made
 * a partially-complete tree visible to whatever was watching the directory.
 */
export async function receiveLocalTransfer(response, dest) {
  const mediaType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (mediaType !== "application/x-tar") {
    throw new CliError("INVALID_RESPONSE", `PAODO returned an unexpected transfer type${mediaType ? ` (${mediaType})` : ""}.`);
  }
  const destination = path.resolve(dest);
  const stageDir = await fs.mkdtemp(path.join(await nearestExistingAncestor(destination), ".paodo-get-"));
  // `ignored` is always empty on a pull and is here anyway: what may travel is the app's rule, applied
  // when the archive is built, so by the time the bytes arrive there is nothing left for this side to
  // skip. Saying so keeps a pull's receipt the same shape as a push's — one transfer, two directions —
  // rather than making a caller remember which of the two omits a key.
  const receipt = { ok: true, created: [], overwritten: [], ignored: [] };
  try {
    const staged = await extractResponse(response, stageDir);

    // Preflight every target before moving anything, so a transfer that cannot be applied whole is
    // refused whole.
    for (const item of staged.items) {
      const target = targetFor(staged.sourceType, destination, item.relPath);
      const type = await existingType(target);
      if (type === "unsupported" || (type !== "missing" && type !== item.type)) {
        throw new CliError("CLI_FILE_CONFLICT", `${target} conflicts with an existing ${type} entry.`);
      }
    }

    const payload = path.join(stageDir, PAYLOAD);
    const destinationType = await existingType(destination);

    // A file payload, or a directory landing where nothing exists yet: one rename, genuinely atomic.
    if (staged.sourceType === "file" || destinationType === "missing") {
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.rename(payload, destination);
      (destinationType === "missing" ? receipt.created : receipt.overwritten).push(destination);
      return receipt;
    }

    await mergeInto(payload, destination, receipt);
    return receipt;
  } finally {
    await fs.rm(stageDir, { recursive: true, force: true });
  }
}

export function defaultDestination(source) {
  const resolved = path.resolve(source);
  return path.basename(resolved);
}
