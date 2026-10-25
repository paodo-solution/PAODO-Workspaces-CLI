import { connect, drivePath, requireDriveId } from "../../client.mjs";
import { receipt } from "../../output.mjs";

/**
 * Irreversible, and more so than `workspace rm`: it removes the drive, every connection to it, and
 * its files, and a drive has no versioning behind it, so nothing here is recoverable from history.
 */
async function run([reference]) {
  const id = requireDriveId(reference);
  await connect().json(drivePath(id), { method: "DELETE" });
  // `ok` and the id, and nothing else. The app's `deleted: true` is dropped rather than relayed, as
  // in `workspace rm`: `ok` already means the command succeeded, and a drive that was never there is
  // refused by the route rather than answered with a receipt.
  receipt({ driveId: id });
}

export default {
  min: 1,
  max: 1,
  run,
};
