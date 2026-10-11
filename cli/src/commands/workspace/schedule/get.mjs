import { connect, requireWorkspaceId } from "../../../client.mjs";
import { receipt } from "../../../output.mjs";
import { endsOf, readSchedule, stateOf } from "./current.mjs";

/** The workspace's scheduled job and whether it is enabled or disabled — the empty job if none is stored. */
async function run([reference]) {
  const id = requireWorkspaceId(reference);
  const schedule = await readSchedule(connect(), id);
  receipt({ workspaceId: id }, { state: stateOf(schedule), ends: endsOf(schedule), schedule });
}

export default {
  min: 1,
  max: 1,
  run,
};
