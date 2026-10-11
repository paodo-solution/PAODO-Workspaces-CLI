import { CliError } from "../../errors.mjs";
// Shared by the five file commands beside it; not a command itself.
//
// The app owns every rule the file group obeys — what a path may say, what travels, what a conflict is,
// what a receipt contains — so the commands stay a walk of the local filesystem plus a request against
// the routes built here.
//
// Listing, reading and deleting go through the routes the browser uses. Pushing and pulling go through
// the transfer route, which the browser cannot use: streaming an archive out of a browser needs fetch
// request streaming, and the browser's own upload wants per-file retry and progress that one request
// cannot give. Both transports sit on the same operations underneath, and both exist under a drive as
// well as a workspace, which is what lets one set of commands serve either — see group.mjs.
//
// The far-side path argument is spelled `spacePath` throughout the group rather than `workspacePath` or
// `drivePath`: those are the two route builders a space carries, and a local that shadows either would
// hand a later edit a path string where it asked for a URL. It is also the honest name now that the
// same argument means a path in a workspace under one noun and a path in a drive under the other.

/**
 * A caller reaching for the root types `/`, the way they would on any filesystem — but the app models
 * a path as relative-or-absent, never absolute, and rejects a leading slash outright. Stripping it
 * here, once, means every command below can accept what a person actually types instead of making each
 * of them reject it the same way the app does.
 *
 * Collapsing to `undefined` once nothing but slashes is left matters because "root" is spelled by
 * omitting the argument, not by sending an empty one — see fileTree below.
 */
export function spaceRoot(spacePath) {
  if (spacePath === undefined) return undefined;
  const trimmed = spacePath.replace(/^\/+/, "");
  return trimmed === "" ? undefined : trimmed;
}

export function filePath(space, id, suffix, query = {}) {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(query)) {
    if (value !== undefined) params.set(name, value);
  }
  const encoded = params.size ? `?${params}` : "";
  return space.resource(id, `/files${suffix ? `/${suffix}` : ""}${encoded}`);
}

/**
 * Depth alone is not a bound: one level of a directory holding a million files is a bounded depth and
 * an unbounded answer. So every listing asks for the app's own ceiling by name (`limit=max`) rather
 * than by number — the number is the app's, and a truncated answer says which one it applied.
 */
const LISTING_CEILING = "max";

/**
 * The tree route, asked for one level. Used by `ls` to answer, and by `rm` to find what to delete.
 *
 * It used to ask for the whole tree, on the reasoning that a truncation a program cannot see is a wrong
 * answer rather than a short one. That is true of a depth limit the caller did not choose, and this is
 * not one: every directory in a one-level answer is marked as a directory (see flatEntries in ls.mjs),
 * so the caller can see exactly where the listing stops and name any of them to go further. What full
 * depth really produced was a first listing that buried the top level under everything below it — the
 * reader has to hold thousands of paths to learn the six that matter, and paying that on a tree it may
 * only want one file out of. One level, then drill down, is both cheaper and easier to read.
 *
 * `spacePath` scopes the listing to one directory, and omitting it lists the root. It is sent rather
 * than used to filter a listing here, because a path is a thing the app decides the meaning of: a
 * directory that does not exist has to answer NOT_FOUND, and a local filter would answer with an empty
 * listing — the same shape as an empty directory, from a typo the caller cannot see.
 */
export function fileTree(client, space, id, spacePath, { measure = false, count = false } = {}) {
  return client
    .json(
      filePath(space, id, "", {
        depth: "1",
        limit: LISTING_CEILING,
        path: spacePath,
        ...(measure ? { measure: "1" } : {}),
        ...(count ? { count: "1" } : {}),
      }),
    )
    .catch((error) => {
      // An app from before `limit=max` reads the word as a bad number, which is not the caller's mistake.
      if (error?.code !== "INVALID_REQUEST" || error.details?.field !== "limit") throw error;
      throw new CliError(
        "CLI_APP_TOO_OLD",
        "This PAODO app does not apply its own listing ceiling (limit=max), which this CLI relies on. " +
          "Update the app, or use the CLI release that matches it.",
        { requestId: error.requestId },
      );
    });
}
