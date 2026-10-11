import { encodeAssignments, parseAssignments } from "../../../assignments.mjs";
import { connect, requireWorkspaceId } from "../../../client.mjs";
import { contractFields } from "../../../contract.mjs";
import { receipt } from "../../../output.mjs";
import { endsOf, schedulePath, stateOf } from "./current.mjs";

/** Words an agent types for `enabled`, answered with the spelling to use instead — never accepted. */
const SHORTHANDS = { enable: "enabled=true", disable: "enabled=false" };

/** Send only named fields; the server merges them atomically with the latest configuration. */
async function run([reference, ...assignments]) {
  const typed = parseAssignments(assignments, SHORTHANDS);
  const id = requireWorkspaceId(reference);
  const client = connect();
  const changes = encodeAssignments(typed, await contractFields("schedule"));
  const stored = await client.json(schedulePath(id), { method: "PATCH", body: changes });
  const applied = Object.fromEntries(Object.keys(changes).map((field) => [field, stored[field]]));
  receipt({ workspaceId: id }, { state: stateOf(stored), ends: endsOf(stored), applied: { ...applied, nextRunAt: stored.nextRunAt } });
}

export default {
  min: 2,
  max: Infinity,
  run,
};
