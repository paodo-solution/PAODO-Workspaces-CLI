import { connect } from "../../client.mjs";
import { CliError } from "../../errors.mjs";
import { receipt } from "../../output.mjs";
import { endpoint, namesById, requireArray } from "./endpoints.mjs";

/**
 * Every edge in the deployment, of both kinds — or, given an id, only the ones touching that one thing.
 *
 * The two connection graphs never mix, and each is served from its own route holding only ids. Read
 * either one alone and you get pairs of UUIDs; read them separately and a caller assembles the
 * deployment's shape itself. So this composes: four reads joined into named edges, which is why it
 * answers with a receipt rather than relaying a resource the way `workspace get` does. `file ls` is
 * the other read shaped this way. Why the id argument names no noun is in endpoints.mjs.
 *
 * Both kinds carry `id` because that is the handle `connection rm` takes, and these two routes are the
 * only place it is published. `workspace get` and `drive get` count connections but publish no ids,
 * so this is where a caller comes for one.
 *
 * The four reads are four requests, so they are not one snapshot: a drive deleted between them leaves
 * a link naming it. That prints as `(not found)` rather than being dropped — the same rendering an id
 * that never existed gets, since the graph accepts one — because a caller cleaning up dangling links
 * needs to see them, and inventing a name for either would hide the thing worth acting on.
 */

/** Refusals meaning "this deployment has no agent-call graph", not "that request was wrong": the app
 *  answers NOT_FOUND when the graph feature is off, and a deployment predating the route has no
 *  handler to answer at all. Neither is a failure of this command — drive links still read fine. */
const GRAPH_ABSENT = new Set(["NOT_FOUND", "CLI_HTTP_NOT_FOUND"]);

const GRAPH_ABSENT_NOTE =
  "Agent calls could not be read — this deployment has the workspace graph turned off. The drive " +
  "links are complete.";

/** Ordered by the names an edge joins, so two runs against an unchanged deployment agree. Ids are
 *  machine-minted, so ordering by one would look like an order without being one. */
function byEndpoints(first, second) {
  const key = (row) =>
    Object.entries(row)
      .filter(([field]) => field !== "id" && !field.endsWith("Id"))
      .map(([, value]) => value)
      .join(" ");
  return key(first).localeCompare(key(second));
}

/** The agent-call edges, or none plus the reason there are none to show. */
async function readAgentCalls(client) {
  try {
    const graph = await client.json("/api/workspace-graph");
    return { edges: requireArray(graph?.edges, "workspace graph") };
  } catch (error) {
    if (!GRAPH_ABSENT.has(error.code)) throw error;
    return { edges: [], note: GRAPH_ABSENT_NOTE };
  }
}

function everything({ edges, links, workspaceNames, driveNames }) {
  return {
    agentCalls: edges
      .map((edge) => ({
        id: edge.id,
        // Named caller/callee rather than source/target: the direction is the whole meaning of an
        // agent edge — only the caller may delegate — and neutral words leave a reader to guess it.
        ...endpoint("caller", edge.source, workspaceNames),
        ...endpoint("callee", edge.target, workspaceNames),
      }))
      .sort(byEndpoints),
    driveLinks: links
      .map((link) => ({
        id: link.id,
        ...endpoint("drive", link.driveId, driveNames),
        ...endpoint("workspace", link.workspaceId, workspaceNames),
      }))
      .sort(byEndpoints),
  };
}

/**
 * One workspace's edges, grouped the way its counts in `workspace get` are named, so the two answers
 * line up field for field. Only the far end of each row is printed — the near end is the subject.
 *
 * Grouped rather than filtered flat because a flat list would show this workspace as `caller` in some
 * rows and `callee` in others, leaving the reader to compare strings to recover the one thing that
 * matters about an agent edge.
 */
function forWorkspace(id, { edges, links, workspaceNames, driveNames }) {
  const calls = (field, kept, far) =>
    edges
      .filter(kept)
      .map((edge) => ({ id: edge.id, ...endpoint(field, far(edge), workspaceNames) }))
      .sort(byEndpoints);
  return {
    workspace: workspaceNames.get(id),
    drives: links
      .filter((link) => link.workspaceId === id)
      .map((link) => ({ id: link.id, ...endpoint("drive", link.driveId, driveNames) }))
      .sort(byEndpoints),
    callers: calls("caller", (edge) => edge.target === id, (edge) => edge.source),
    callees: calls("callee", (edge) => edge.source === id, (edge) => edge.target),
  };
}

/** One drive's links. A drive has no agent calls, so `workspaces` is the whole of what it can hold. */
function forDrive(id, { links, workspaceNames, driveNames }) {
  return {
    drive: driveNames.get(id),
    workspaces: links
      .filter((link) => link.driveId === id)
      .map((link) => ({ id: link.id, ...endpoint("workspace", link.workspaceId, workspaceNames) }))
      .sort(byEndpoints),
  };
}

async function run([reference]) {
  const client = connect();
  const [workspaces, drives, links, graph] = await Promise.all([
    client.json("/api/workspaces"),
    client.json("/api/drives"),
    client.json("/api/drive-connections"),
    readAgentCalls(client),
  ]);

  const assembled = {
    edges: graph.edges,
    links: requireArray(links, "drive connection list"),
    workspaceNames: namesById(requireArray(workspaces, "workspace list")),
    driveNames: namesById(requireArray(drives, "drive list")),
  };
  const note = graph.note ? { note: graph.note } : {};

  if (reference === undefined) {
    receipt(null, { ...everything(assembled), ...note });
    return;
  }

  if (assembled.workspaceNames.has(reference)) {
    receipt({ workspaceId: reference }, { ...forWorkspace(reference, assembled), ...note });
    return;
  }
  if (assembled.driveNames.has(reference)) {
    receipt({ driveId: reference }, { ...forDrive(reference, assembled), ...note });
    return;
  }

  // Refused rather than answered with an empty listing: nothing is connected to it and no such thing
  // exists read identically otherwise, and only one of them is worth acting on.
  throw new CliError("CLI_NOT_FOUND", `No workspace or drive has the id "${reference}".`);
}

export default {
  min: 0,
  max: 1,
  run,
};
