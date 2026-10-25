import { connect, requireWorkspaceId, workspacePath } from "../../client.mjs";
import { receipt } from "../../output.mjs";

/**
 * One workspace, nested under `workspace` rather than spread into the envelope.
 *
 * Nested because the resource and the envelope would otherwise share a namespace, and they already
 * collide: a workspace carries `internetAccess`, and so does every key receipt, where it means the same
 * fact about a different subject. Kept apart, `workspace` means one thing in every command that returns
 * one and a caller never has to know which keys came from where.
 *
 * `id` comes out of it because the envelope's `workspaceId` is that id — one spelling, at the level
 * that identifies what the command acted on.
 */
async function run([reference]) {
  const id = requireWorkspaceId(reference);
  const { id: _id, ...workspace } = await connect().json(workspacePath(id));
  receipt({ workspaceId: id }, { workspace });
}

export default {
  min: 1,
  max: 1,
  run,
};
