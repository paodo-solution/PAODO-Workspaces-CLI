import { connect } from "../../client.mjs";
import { rethrowUnpublished } from "../../contract.mjs";
import { usageError } from "../../errors.mjs";
import { receipt } from "../../output.mjs";

/**
 * Remove one connection, of either kind. Which graph an id belongs to, and whether it is a connection
 * id at all, is the app's to say (DELETE /api/connections/{id}); nothing here reads the id.
 *
 * `deleted: false` is an answer, not a failure: it says the id is not connected to anything now, which
 * is the state that was asked for. It is what an id already removed gets — including one this command
 * was run on twice, and one belonging to a workspace or drive deleted since `ls` printed it.
 *
 * Nothing is confirmed first. A drive link removes a workspace's reach into shared files and an agent
 * call revokes a delegation, but neither destroys anything: both are re-established by `create`.
 */
async function run([connectionId]) {
  // An empty id would address the collection rather than a connection, which is a different route.
  if (!connectionId) throw usageError("Connection id is required.");
  const { deleted } = await connect()
    .json(`/api/connections/${encodeURIComponent(connectionId)}`, { method: "DELETE" })
    .catch((error) => rethrowUnpublished(error, "remove a connection by its id (DELETE /api/connections/{id})"));
  receipt({ connectionId }, { deleted });
}

export default {
  min: 1,
  max: 1,
  run,
};
