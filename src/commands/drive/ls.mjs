import { connect } from "../../client.mjs";
import { CliError } from "../../errors.mjs";
import { receipt } from "../../output.mjs";

/**
 * Every drive, under `drives`.
 *
 * Wrapped for the same reason `workspace ls` is: the route serves a bare JSON array, which is the one
 * output shape with nowhere to put `ok`, so the command that tells you what exists would otherwise be
 * the one a caller could not check the way it checks the rest.
 */
async function run() {
  const drives = await connect().json("/api/drives");
  if (!Array.isArray(drives)) throw new CliError("INVALID_RESPONSE", "PAODO returned an invalid drive list.");
  receipt(null, { drives });
}

export default {
  min: 0,
  max: 0,
  run,
};
