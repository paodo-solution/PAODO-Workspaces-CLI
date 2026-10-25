import {
  connect,
  requireConversationId,
  requireSessionId,
  requireWorkspaceId,
  sessionPath,
} from "../../../../../client.mjs";
import { CliError } from "../../../../../errors.mjs";
import { receipt } from "../../../../../output.mjs";

/** A session's tool calls, oldest first, each with the size of its input and output, under `calls`. */
async function run([workspaceReference, conversationReference, sessionReference]) {
  const workspaceId = requireWorkspaceId(workspaceReference);
  const conversationId = requireConversationId(conversationReference);
  const sessionId = requireSessionId(sessionReference);
  const calls = (await connect().json(sessionPath(workspaceId, conversationId, sessionId, "/calls")))?.calls;
  if (!Array.isArray(calls)) throw new CliError("INVALID_RESPONSE", "PAODO returned an invalid call list.");
  receipt({ workspaceId, conversationId, sessionId }, { calls });
}

export default {
  min: 3,
  max: 3,
  run,
};
