import { issue } from "./channel.mjs";

/** Creates a channel's first secret. Refuses to overwrite one that already exists. */
async function run(args) {
  await issue("generate", args);
}

export default {
  min: 2,
  max: 2,
  run,
};
