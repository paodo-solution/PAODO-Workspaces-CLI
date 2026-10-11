import { destroy } from "./channel.mjs";

/**
 * Destroys the secret, leaving the channel's on/off switch alone.
 * Independent of that switch: a leaked key is revoked the same way whether its channel is open or
 * closed. Fails when there is no secret to destroy, so a revocation that reports success is always one
 * that ended a live key.
 *
 * The route reports both axes afterwards and this relays them — `workspaceApiHasKey: false` (or the
 * Mcp spelling) confirming the key is gone, `workspaceApiAccess` saying whether the channel it served
 * is still open. Destroying the last key leaves that channel reachable and rejecting everything, which
 * is a thing to go and fix rather than to discover from the receipt of a call that already succeeded.
 */
async function run(args) {
  await destroy(args);
}

export default {
  min: 2,
  max: 2,
  run,
};
