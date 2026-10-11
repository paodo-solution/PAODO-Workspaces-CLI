import {
  connect,
  requireConversationId,
  requireSessionId,
  requireWorkspaceId,
  sessionPath,
} from "../../../../client.mjs";
import { CliError } from "../../../../errors.mjs";
import { receipt } from "../../../../output.mjs";

/** One session of a conversation: its message and final answer in full and what it cost, under `session`. */
async function run([workspaceReference, conversationReference, sessionReference]) {
  const workspaceId = requireWorkspaceId(workspaceReference);
  const conversationId = requireConversationId(conversationReference);
  const sessionId = requireSessionId(sessionReference);
  const session = (await connect().json(sessionPath(workspaceId, conversationId, sessionId)))?.session;
  if (!session || typeof session !== "object" || Array.isArray(session)) {
    throw new CliError("INVALID_RESPONSE", "PAODO returned an invalid session.");
  }
  receipt({ workspaceId, conversationId }, { session });
}

export default {
  min: 3,
  max: 3,
  run,
};
