import { connect } from "../../client.mjs";
import { CliError } from "../../errors.mjs";
import { receipt } from "../../output.mjs";

/**
 * Every workspace, under `workspaces`.
 *
 * The list used to be printed as the bare JSON array the route serves, which is the one output shape
 * that cannot carry `ok` — there is nowhere on an array to put it. So the command that tells you what
 * exists was the only one a caller could not check the same way it checks the rest.
 */
async function run() {
  const workspaces = await connect().json("/api/workspaces");
  if (!Array.isArray(workspaces)) throw new CliError("INVALID_RESPONSE", "PAODO returned an invalid workspace list.");
  receipt(null, { workspaces });
}

export default {
  min: 0,
  max: 0,
  run,
};
