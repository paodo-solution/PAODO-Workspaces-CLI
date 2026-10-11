import path from "node:path";
import { connect } from "../../client.mjs";
import { receiveLocalTransfer } from "../../file-transfer.mjs";
import { receipt } from "../../output.mjs";
import { filePath, spaceRoot } from "./route.mjs";

/** The named space -> this machine. The named path is read; the local one is written. */
export default function (space) {
  async function run([reference, spaceSource, suppliedDest]) {
    const id = space.requireId(reference);
    const normalized = spaceRoot(spaceSource);
    const root = normalized === undefined || normalized === ".";
    const localDest = suppliedDest ?? (root ? "." : path.posix.basename(normalized.replace(/\/$/, "")));
    const response = await connect().request(filePath(space, id, "transfer", { path: normalized }), {
      accept: "application/x-tar",
    });
    // A pull writes to this machine, so it reports like any other mutation — the paths it created and
    // the ones it replaced, which is the half of the transfer the app's own receipt cannot see. Same
    // three lists as a push, and `destination: "local"` says which side of the boundary they name: these
    // are absolute paths on this machine, not paths in the workspace or drive.
    const { ok: _ok, ...applied } = await receiveLocalTransfer(response, localDest);
    receipt({ [space.subject]: id }, { destination: "local", ...applied });
  }

  return { min: 2, max: 3, run };
}
