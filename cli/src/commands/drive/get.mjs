import { connect, drivePath, requireDriveId } from "../../client.mjs";
import { receipt } from "../../output.mjs";

/**
 * One drive, nested under `drive` rather than spread into the envelope — the same split
 * `workspace get` makes, so a resource field and an envelope field never share a namespace.
 *
 * `id` comes out of it because the envelope's `driveId` is that id: one spelling, at the level that
 * identifies what the command acted on.
 */
async function run([reference]) {
  const id = requireDriveId(reference);
  const { id: _id, ...drive } = await connect().json(drivePath(id));
  receipt({ driveId: id }, { drive });
}

export default {
  min: 1,
  max: 1,
  run,
};
