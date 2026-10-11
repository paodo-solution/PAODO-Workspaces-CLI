import { connect, requireWorkspaceId, workspacePath } from "../../../client.mjs";
import { CliError } from "../../../errors.mjs";
import { receipt } from "../../../output.mjs";

/** A workspace's conversations, newest first, under `conversations`. The list route never carries a transcript. */
async function run([reference]) {
  const id = requireWorkspaceId(reference);
  const conversations = (await connect().json(workspacePath(id, "/conversations")))?.conversations;
  if (!Array.isArray(conversations)) {
    throw new CliError("INVALID_RESPONSE", "PAODO returned an invalid conversation list.");
  }
  receipt({ workspaceId: id }, { conversations });
}

export default {
  min: 1,
  max: 1,
  run,
};
