import { connect } from "../../client.mjs";
import { rethrowUnpublished } from "../../contract.mjs";
import { receipt } from "../../output.mjs";
import { namedEnds } from "./endpoints.mjs";

/**
 * Connect two things, whichever two they are: a drive to a workspace, or a workspace to a workspace.
 *
 * One command and one request, because the caller already holds two ids and the app already knows what
 * they are. Which kind of connection a pair makes, and which pairs are refused, is the app's decision
 * (POST /api/connections); nothing here classifies an id or names a kind.
 *
 * What was made is read back from the reply rather than assumed: each end comes under the role the app
 * gave it — caller/callee, drive/workspace — as the name to read and the id the next command takes.
 */
async function run([from, to]) {
  const { id, kind: _kind, ...ends } = await connect()
    .json("/api/connections", { method: "POST", body: { from, to } })
    .catch((error) => rethrowUnpublished(error, "connect two ids in one request (POST /api/connections)"));
  receipt({ connectionId: id }, namedEnds(ends));
}

export default {
  min: 2,
  max: 2,
  run,
};
