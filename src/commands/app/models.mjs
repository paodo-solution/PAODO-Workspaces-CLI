import { connect } from "../../client.mjs";
import { receipt } from "../../output.mjs";

/** One provider-keyed hierarchy, under `providers`, exactly as the app names it. */
async function run() {
  receipt(null, await connect().json("/api/models"));
}

export default {
  min: 0,
  max: 0,
  run,
};
