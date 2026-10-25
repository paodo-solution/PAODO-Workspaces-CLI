import { connect, requireWorkspaceId, workspacePath } from "../../client.mjs";
import { receipt } from "../../output.mjs";

/** Irreversible: removes the workspace and its directory. */
async function run([reference]) {
  const id = requireWorkspaceId(reference);
  await connect().json(workspacePath(id), { method: "DELETE" });
  // `ok` and the id, and nothing else. The app's `deleted: true` is dropped rather than relayed: `ok`
  // already means the command succeeded, so a second boolean saying the same thing is one more field a
  // reader has to decide the meaning of — and there is no `created: true` on the other side to pair it
  // with. What a deletion can honestly report is that it worked and what it worked on.
  receipt({ workspaceId: id });
}

export default {
  min: 1,
  max: 1,
  run,
};
