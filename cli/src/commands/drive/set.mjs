import { connect, drivePath, requireDriveId } from "../../client.mjs";
import { encodeAssignments, parseAssignments } from "../../assignments.mjs";
import { contractFields } from "../../contract.mjs";
import { receipt } from "../../output.mjs";

/** Updates a drive's fields; which ones exist is the app's contract, as in workspace/set.mjs. */
async function run([reference, ...assignments]) {
  const typed = parseAssignments(assignments);
  const id = requireDriveId(reference);
  const body = encodeAssignments(typed, await contractFields("drive"));
  const result = await connect().json(drivePath(id), { method: "PATCH", body });
  // `applied`, exactly as `workspace set` reports it: what the route confirms it moved, in the value
  // the drive now holds — a name comes back trimmed and NFC-folded, which is not always what was sent.
  receipt({ driveId: result.driveId ?? id }, { applied: result.applied });
}

export default {
  min: 2,
  max: Infinity,
  run,
};
