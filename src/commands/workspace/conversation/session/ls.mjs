import { connect, conversationPath, requireConversationId, requireWorkspaceId } from "../../../../client.mjs";
import { CliError } from "../../../../errors.mjs";
import { receipt } from "../../../../output.mjs";

/** A conversation's runs, newest first, each with the start of its message and answer, under `sessions`. */
async function run([workspaceReference, conversationReference]) {
  const workspaceId = requireWorkspaceId(workspaceReference);
  const conversationId = requireConversationId(conversationReference);
  const sessions = (await connect().json(conversationPath(workspaceId, conversationId, "/sessions")))?.sessions;
  if (!Array.isArray(sessions)) throw new CliError("INVALID_RESPONSE", "PAODO returned an invalid session list.");
  receipt({ workspaceId, conversationId }, { sessions });
}

export default {
  min: 2,
  max: 2,
  run,
};
