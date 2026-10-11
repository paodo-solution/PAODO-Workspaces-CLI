// A PAODO client with endpoint and token resolved once, so multi-request commands hit one endpoint.
// Path builders live here so every id is URL-encoded in one place.
import { loadConfig } from "./config.mjs";
import { usageError } from "./errors.mjs";
import { json, request } from "./http.mjs";

export function connect() {
  const { endpoint, token } = loadConfig();
  return {
    endpoint,
    /** Parsed JSON, or a CliError carrying the app's own code. */
    json: (resource, options) => json(endpoint, token, resource, options),
    /** The raw successful Response, body unread — for bodies that are not JSON in either direction. */
    request: (resource, options) => request(endpoint, token, resource, options),
  };
}

function resourcePath(collection, id, suffix) {
  return `/api/${collection}/${encodeURIComponent(id)}${suffix}`;
}

export function workspacePath(id, suffix = "") {
  return resourcePath("workspaces", id, suffix);
}

export function drivePath(id, suffix = "") {
  return resourcePath("drives", id, suffix);
}

export function conversationPath(workspaceId, conversationId, suffix = "") {
  return workspacePath(workspaceId, `/conversations/${encodeURIComponent(conversationId)}${suffix}`);
}

export function sessionPath(workspaceId, conversationId, sessionId, suffix = "") {
  return conversationPath(workspaceId, conversationId, `/sessions/${encodeURIComponent(sessionId)}${suffix}`);
}

/**
 * The guard beside the builder, because arity alone does not give it: a command that declares `min: 1`
 * is still handed an empty string by `paodo workspace get ""`, and an empty id builds a URL that is a
 * different route rather than a missing resource.
 */
function requireId(noun, reference) {
  if (!reference) throw usageError(`${noun} id is required.`);
  return reference;
}

export function requireWorkspaceId(reference) {
  return requireId("Workspace", reference);
}

export function requireDriveId(reference) {
  return requireId("Drive", reference);
}

export function requireConversationId(reference) {
  return requireId("Conversation", reference);
}

export function requireSessionId(reference) {
  return requireId("Session", reference);
}

export function requireCallId(reference) {
  return requireId("Call", reference);
}
