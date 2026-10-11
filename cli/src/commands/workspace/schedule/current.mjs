// A workspace's one scheduled job, as get and set both read it: never absent, always enabled or disabled.
import { workspacePath } from "../../../client.mjs";
import { contractFields } from "../../../contract.mjs";
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

/**
 * The job a workspace has before the app stores one: every setting the app's contract names, empty, and
 * disabled. Nothing is pre-filled, since an agent never sees a guess — the first set names each setting
 * and the app refuses any missing. Built from the contract so a setting the app gains is shown here too.
 */
async function emptyJob() {
  const settings = Object.entries(await contractFields("schedule"));
  return Object.fromEntries([...settings.map(([name, { type }]) => [name, type === "boolean" ? false : null]), ["nextRunAt", null]]);
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
 * The stored job with its own id first and the envelope's `workspaceId` dropped, or the empty job when
 * none is stored yet.
 */
export async function readSchedule(client, id) {
  const stored = await client.json(schedulePath(id));
  if (!stored) return emptyJob();
  const { id: scheduleId, workspaceId: _workspaceId, endAt = null, ...rest } = stored;
  return withEndAt({ id: scheduleId, ...rest }, endAt);
}
