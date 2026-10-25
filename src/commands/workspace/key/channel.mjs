// Shared by the three key commands beside it; not a command itself.
//
// The three verbs are kept apart on purpose. `generate` refuses to overwrite an existing secret and
// `rotate` refuses to invent a missing one, so neither can quietly do the other's job to a channel
// whose state you misremembered — which is why each names itself on the wire below rather than letting
// the server infer intent from the channel's current state.
//
// None of them depends on the channel being open: a secret can be issued before `set …Access=true`,
// which is the order that avoids leaving a channel live while you go and deliver the key.
//
// Neither secret is usable by this CLI — issuing and destroying them is credential administration.
import { connect, requireWorkspaceId, workspacePath } from "../../../client.mjs";
import { channels } from "../../../contract.mjs";
import { usageError } from "../../../errors.mjs";
import { receipt } from "../../../output.mjs";

/**
 * The route for one channel of one workspace. Which channels exist and how their routes are spelled is
 * the app's contract; the refusal names the ones it published, so a channel the app gains needs nothing here.
 */
async function channelPath(id, channel) {
  const known = await channels();
  if (!Object.hasOwn(known, channel ?? "")) {
    const accepted = Object.keys(known).map((name) => `"${name}"`).join(" or ");
    throw usageError(`Channel must be ${accepted}, got ${channel ? `"${channel}"` : "nothing"}.`);
  }
  return workspacePath(id, `/${known[channel]}`);
}

// Both verbs relay the app's body verbatim under the envelope. The routes already name their fields
// channel-specifically (workspaceApiKey, workspaceMcpAccess, ...), the same vocabulary `workspace get`
// uses, so there is nothing to rename here and no second spelling for a reader to learn.

/** POSTs the named operation to a channel, which is how generate and rotate differ on the wire. */
export async function issue(operation, [reference, channel]) {
  const id = requireWorkspaceId(reference);
  const body = await connect().json(await channelPath(id, channel), { method: "POST", body: { operation } });
  receipt({ workspaceId: id }, body);
}

/** DELETEs a channel's secret. Separate from issue only in the verb and in having no plaintext. */
export async function destroy([reference, channel]) {
  const id = requireWorkspaceId(reference);
  const body = await connect().json(await channelPath(id, channel), { method: "DELETE" });
  receipt({ workspaceId: id }, body);
}
