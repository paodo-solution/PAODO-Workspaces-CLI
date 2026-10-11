import { issue } from "./channel.mjs";

/** Replaces an existing channel secret, invalidating the previous one. Refuses to invent a missing one. */
async function run(args) {
  await issue("rotate", args);
}

export default {
  min: 2,
  max: 2,
  run,
};
