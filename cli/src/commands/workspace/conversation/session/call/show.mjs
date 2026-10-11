import {
  connect,
  requireCallId,
  requireConversationId,
  requireSessionId,
  requireWorkspaceId,
  sessionPath,
} from "../../../../../client.mjs";
import { CliError } from "../../../../../errors.mjs";
import { receipt } from "../../../../../output.mjs";

/** One tool call of a session with its input and output in full, under `call`. */
async function run([workspaceReference, conversationReference, sessionReference, callReference]) {
  const workspaceId = requireWorkspaceId(workspaceReference);
  const conversationId = requireConversationId(conversationReference);
  const sessionId = requireSessionId(sessionReference);
  const callId = requireCallId(callReference);
  const path = sessionPath(workspaceId, conversationId, sessionId, `/calls/${encodeURIComponent(callId)}`);
  const call = (await connect().json(path))?.call;
  if (!call || typeof call !== "object" || Array.isArray(call)) {
    throw new CliError("INVALID_RESPONSE", "PAODO returned an invalid call.");
  }
  receipt({ workspaceId, conversationId, sessionId }, { call });
}

export default {
  min: 4,
  max: 4,
  run,
};
