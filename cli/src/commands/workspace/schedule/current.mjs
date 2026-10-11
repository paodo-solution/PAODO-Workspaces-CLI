// A workspace's one scheduled job, as get and set both read it: never absent, always enabled or disabled.
import { workspacePath } from "../../../client.mjs";
import { Note } from "../../../output.mjs";

export function schedulePath(id) {
  return workspacePath(id, "/schedule");
}

/** The word every receipt states the job in, so nobody has to read `enabled` to know whether it fires. */
export function stateOf(schedule) {
  return schedule.enabled === true ? "enabled" : "disabled";
}

/** Beside `state` in every receipt, so a job with no end date can never be mistaken for a bounded one. */
export function endsOf(schedule) {
  return schedule.endAt || new Note("never (runs until disabled)");
}

/** `endAt` right after `startAt`, printed as (none) when unset rather than left out. */
function withEndAt(job, endAt) {
  const ordered = {};
  for (const [key, value] of Object.entries(job)) {
    ordered[key] = value;
    if (key === "startAt") ordered.endAt = endAt;
  }
  return ordered;
}

/**
 * The job as the app answers it, with its own id first and the envelope's `workspaceId` dropped. A job
 * never saved is the app's answer too: every setting empty, disabled, and no id.
 */
export async function readSchedule(client, id) {
  const { id: scheduleId, workspaceId: _workspaceId, endAt = null, ...rest } = await client.json(schedulePath(id));
  return withEndAt({ ...(scheduleId ? { id: scheduleId } : {}), ...rest }, endAt);
}
