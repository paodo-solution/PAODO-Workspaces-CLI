import { connect, requireWorkspaceId, workspacePath } from "../../client.mjs";
import { encodeAssignments, parseAssignments } from "../../assignments.mjs";
import { contractFields } from "../../contract.mjs";
import { receipt } from "../../output.mjs";

/**
 * Updates workspace fields, including the two access toggles. Which fields exist, and the type each
 * is encoded as, is the app's contract — nothing here names one, so a field the app gains is settable
 * at once. Values are not checked either: the app owns every bound, enum and model rule.
 */
async function run([reference, ...assignments]) {
  const typed = parseAssignments(assignments);
  const id = requireWorkspaceId(reference);
  const body = encodeAssignments(typed, await contractFields("workspace"));
  const result = await connect().json(workspacePath(id), { method: "PATCH", body });
  // The app's warning, when it sends one, is relayed as written: the CLI knows no field's rules.
  receipt(
    { workspaceId: result.workspaceId ?? id },
    { applied: result.applied, ...(result.warning ? { warning: result.warning } : {}) },
  );
}

export default {
  min: 2,
  max: Infinity,
  run,
};
