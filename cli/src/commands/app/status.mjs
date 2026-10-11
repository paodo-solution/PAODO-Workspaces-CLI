import { connect } from "../../client.mjs";
import { receipt } from "../../output.mjs";

/**
 * The app's liveness answer, under the envelope every command shares.
 *
 * `status` is the app's word and stays: `ok` says this command succeeded — that the CLI reached PAODO
 * and got an answer — while `status` is what the answer was. They are not the same claim, and the
 * request that most needs them apart is this one: a reachable app reporting itself unwell is exactly
 * what `app status` is for, and folding the two would leave nowhere to say it.
 */
async function run() {
  receipt(null, await connect().json("/api/status"));
}

export default {
  min: 0,
  max: 0,
  run,
};
